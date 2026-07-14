import { z } from "zod";
import { config } from "../config";

const aiActionSchema = z.object({
  operation: z.enum(["create", "update", "delete"]),
  taskId: z.number().int().positive().optional(),
  data: z
    .object({
      projectId: z.number().int().positive().optional(),
      title: z.string().min(1).optional(),
      description: z.string().optional(),
      status: z.enum(["todo", "in_progress", "done"]).optional(),
      priority: z.enum(["low", "medium", "high"]).optional(),
      assigneeId: z.number().int().positive().optional(),
    })
    .optional(),
});

// BEFORE: Schema hanya mendukung CRUD Task via { actions: [...] } (mode mutate saja).
// AFTER: Ditambah query schema untuk intent baca data project dari DB.
const aiQuerySchema = z.object({
  intent: z.enum(["projects_by_priority", "projects_by_assignee"]),
  priority: z.enum(["low", "medium", "high"]).optional(),
  userName: z.string().min(1).optional(),
  userId: z.number().int().positive().optional(),
  /** Default for "sedang mengerjakan" is in_progress when omitted. */
  taskStatus: z.enum(["todo", "in_progress", "done"]).optional(),
});

// BEFORE (schema lama — hanya mutate):
// export const aiCommandSchema = z.object({
//   actions: z.array(aiActionSchema).min(1),
// });
// export type AiCommand = z.infer<typeof aiCommandSchema>;
//
// AFTER: Discriminated union mode "mutate" | "query" agar AI bisa CRUD ATAU query.
export const aiCommandSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("mutate"),
    actions: z.array(aiActionSchema).min(1),
  }),
  z.object({
    mode: z.literal("query"),
    query: aiQuerySchema,
  }),
]);

export type AiCommand = z.infer<typeof aiCommandSchema>;
export type AiQuery = z.infer<typeof aiQuerySchema>;
export type AiMutateCommand = Extract<AiCommand, { mode: "mutate" }>;
export type AiQueryCommand = Extract<AiCommand, { mode: "query" }>;

// BEFORE (systemPrompt lama — mutate Task only) — disimpan lengkap:
/*
const systemPrompt = `
You convert natural language into strict JSON task commands.
Rules:
- Only operate on table "Task".
- Never return operations for User table.
- Return ONLY a raw JSON object (no markdown, no explanation).
- Use operation values exactly: "create", "update", or "delete".
- JSON shape:
{
  "actions": [
    {
      "operation": "create",
      "taskId": 1,
      "data": {
        "projectId": 1,
        "title": "Task title",
        "description": "optional",
        "status": "todo",
        "priority": "medium",
        "assigneeId": 2
      }
    }
  ]
}
- For delete: include taskId.
- For update: include taskId and at least one field in data.
- For create: include projectId, title, assigneeId in data.
- If prompt asks user table changes, return:
{"actions":[],"error":"USER_TABLE_OPERATION_NOT_ALLOWED"}
`;
*/
// AFTER: Prompt mendukung mode query (high priority / project by user) + mode mutate.
const systemPrompt = `
You convert natural language into strict JSON for a task-management API.
Return ONLY a raw JSON object (no markdown, no explanation).

Decide mode:
1) "query" — user asks to LIST / SHOW / FIND projects or work status (read-only).
2) "mutate" — user asks to CREATE / UPDATE / DELETE tasks.

QUERY shapes:

A) Projects that currently have a given task priority (e.s. high):
{"mode":"query","query":{"intent":"projects_by_priority","priority":"high"}}

B) Projects a specific user is currently working on:
{"mode":"query","query":{"intent":"projects_by_assignee","userName":"Budi","taskStatus":"in_progress"}}
- Prefer userName from the prompt; use userId only if an ID is stated.
- For "sedang mengerjakan" / "currently working", set taskStatus to "in_progress".
- If they ask for all assigned projects without "sedang/current", omit taskStatus.

MUTATE shape (Task table only):
{"mode":"mutate","actions":[{"operation":"create","taskId":1,"data":{"projectId":1,"title":"Task title","description":"optional","status":"todo","priority":"medium","assigneeId":2}}]}
- create: projectId, title, assigneeId required in data
- update: taskId + at least one data field
- delete: taskId required
- Never mutate User table. If asked, return:
{"mode":"mutate","actions":[]}
`;

function extractGeminiText(data: {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
}): string {
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((part) => part.text?.trim())
    .filter((text): text is string => Boolean(text))
    .join("\n")
    .trim();
}

function parseJsonFromAiText(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("AI response is empty.");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      return JSON.parse(fenced[1].trim());
    }

    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }

    throw new Error("AI response is not a valid JSON.");
  }
}

// BEFORE: Validasi langsung aiCommandSchema.safeParse(parsedUnknown) tanpa normalisasi mode.
// AFTER: Normalisasi payload lama { actions } -> { mode: "mutate", actions } agar tetap kompatibel.
function normalizeAiPayload(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object") return parsed;
  const obj = parsed as Record<string, unknown>;

  // Backward-compatible: old shape { actions: [...] } without mode.
  if (!("mode" in obj) && Array.isArray(obj.actions)) {
    return { mode: "mutate", actions: obj.actions };
  }

  return parsed;
}

function validateAiCommand(parsedUnknown: unknown): AiCommand {
  const normalized = normalizeAiPayload(parsedUnknown);
  const validation = aiCommandSchema.safeParse(normalized);
  if (!validation.success) {
    throw new Error("AI JSON format is invalid.");
  }
  return validation.data;
}

const geminiEndpoint = () =>
  `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent?key=${config.geminiApiKey}`;

// BEFORE: Tidak ada endpoint stream; hanya generateContent (non-stream).
const geminiStreamEndpoint = () =>
  `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:streamGenerateContent?alt=sse&key=${config.geminiApiKey}`;

// BEFORE: Body request Gemini di-inline di dalam callGemini() seperti:
/*
  body: JSON.stringify({
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
    },
  }),
*/
// AFTER: Diekstrak ke helper agar dipakai ulang oleh callGemini + callGeminiStreaming.
function buildGeminiBody(prompt: string) {
  return {
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
    },
  };
}

/*
 * ===================================================================================
 * KODE LAMA callGemini (sebelum Update Project) — disimpan sebagai referensi
 * ===================================================================================
 *
 * export async function callGemini(prompt: string): Promise<AiCommand> {
 *   if (!config.geminiApiKey) {
 *     throw new Error("GEMINI_API_KEY is not configured.");
 *   }
 *
 *   // We force deterministic JSON output to reduce hallucination risk.
 *   const response = await fetch(
 *     `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent?key=${config.geminiApiKey}`,
 *     {
 *       method: "POST",
 *       headers: {
 *         "Content-Type": "application/json",
 *       },
 *       body: JSON.stringify({
 *         systemInstruction: {
 *           parts: [{ text: systemPrompt }],
 *         },
 *         contents: [
 *           {
 *             role: "user",
 *             parts: [{ text: prompt }],
 *           },
 *         ],
 *         generationConfig: {
 *           temperature: 0,
 *           responseMimeType: "application/json",
 *         },
 *       }),
 *     },
 *   );
 *
 *   if (!response.ok) {
 *     const text = await response.text();
 *     throw new Error(`Gemini error: ${text}`);
 *   }
 *
 *   const data = (await response.json()) as {
 *     candidates?: Array<{
 *       content?: { parts?: Array<{ text?: string }> };
 *     }>;
 *   };
 *
 *   const rawContent = extractGeminiText(data);
 *   const parsedUnknown = parseJsonFromAiText(rawContent);
 *
 *   // Defensive validation before touching database layer.
 *   const validation = aiCommandSchema.safeParse(parsedUnknown);
 *   if (!validation.success) {
 *     throw new Error("AI JSON format is invalid.");
 *   }
 *
 *   return validation.data;
 * }
 */

// BEFORE: callGemini mengembalikan AiCommand dengan bentuk { actions } saja,
//         lalu validasi inline: aiCommandSchema.safeParse(parsedUnknown).
// AFTER: Tetap non-stream, tapi output bisa mode mutate ATAU query; validasi via validateAiCommand().
export async function callGemini(prompt: string): Promise<AiCommand> {
  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  // We force deterministic JSON output to reduce hallucination risk.
  const response = await fetch(geminiEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildGeminiBody(prompt)),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini error: ${text}`);
  }

  const data = (await response.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };

  const rawContent = extractGeminiText(data);
  // BEFORE:
  // const parsedUnknown = parseJsonFromAiText(rawContent);
  // const validation = aiCommandSchema.safeParse(parsedUnknown);
  // if (!validation.success) {
  //   throw new Error("AI JSON format is invalid.");
  // }
  // return validation.data;
  return validateAiCommand(parseJsonFromAiText(rawContent));
}

/**
 * BARU (plus point Stream Response).
 * BEFORE: Hanya callGemini non-stream (generateContent) — tidak ada fungsi streaming.
 * AFTER: streamGenerateContent + SSE deltas, lalu validasi JSON intent yang sama.
 */
export async function callGeminiStreaming(
  prompt: string,
  onDelta: (text: string) => void,
): Promise<AiCommand> {
  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  const response = await fetch(geminiStreamEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildGeminiBody(prompt)),
  });

  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(`Gemini stream error: ${text}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulated = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      try {
        const chunk = JSON.parse(payload) as {
          candidates?: Array<{
            content?: { parts?: Array<{ text?: string }> };
          }>;
        };
        const delta = extractGeminiText(chunk);
        if (delta) {
          accumulated += delta;
          onDelta(delta);
        }
      } catch {
        // Ignore partial SSE frames that are not valid JSON yet.
      }
    }
  }

  return validateAiCommand(parseJsonFromAiText(accumulated));
}
