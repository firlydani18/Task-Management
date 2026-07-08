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

export const aiCommandSchema = z.object({
  actions: z.array(aiActionSchema).min(1),
});

export type AiCommand = z.infer<typeof aiCommandSchema>;

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

export async function callGemini(prompt: string): Promise<AiCommand> {
  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  // We force deterministic JSON output to reduce hallucination risk.
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent?key=${config.geminiApiKey}`,
    {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
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
  },
  );

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
  const parsedUnknown = parseJsonFromAiText(rawContent);

  // Defensive validation before touching database layer.
  const validation = aiCommandSchema.safeParse(parsedUnknown);
  if (!validation.success) {
    throw new Error("AI JSON format is invalid.");
  }

  return validation.data;
}
