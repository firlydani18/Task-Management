# Yapindo Technical Test Backend

REST API Task Management untuk technical test Backend Developer.

## Ringkasan Project

API ini mengelola **project** dan **task** dengan autentikasi JWT, kontrol akses berbasis role, serta fitur **AI Command** yang menerjemahkan instruksi bahasa natural menjadi operasi CRUD pada tabel `Task`.

Alur utama:

1. User login → dapat JWT token
2. Admin mengelola project (CRUD)
3. Admin/User melihat project & task
4. User mengirim prompt ke `/ai/command` → Gemini menghasilkan JSON aksi → backend eksekusi ke database dalam transaction
5. Setiap eksekusi AI dicatat di `AuditLog`

## Scope Requirement yang Dipenuhi

- Auth: `POST /register`, `POST /login`
- JWT middleware + role authorization (`admin`, `user`)
- Admin Project CRUD:
  - `POST /projects`
  - `GET /projects`
  - `GET /projects/:id`
  - `PUT /projects/:id`
  - `DELETE /projects/:id`
- User & Admin:
  - `GET /projects`
  - `GET /projects/:id/tasks`
  - `POST /ai/command`
- AI Command:
  - Prompt natural language → Gemini JSON terstruktur
  - Output AI divalidasi aman (Zod + parser defensif)
  - Eksekusi CRUD Task berdasarkan hasil parsing AI
  - Eksekusi multi aksi dalam transaction (rollback jika ada gagal)
  - Guardrail: larang mutasi tabel `User` (assign task ke user ID tetap diizinkan)
  - Logging setiap call ke tabel `AuditLog`
- Database seeding sudah disiapkan
- Postman collection/environment tersedia

## Teknologi

| Layer | Teknologi |
|-------|-----------|
| Runtime | Node.js + Express + TypeScript |
| Database | PostgreSQL + Prisma ORM |
| Auth | JWT + bcryptjs |
| Validasi | Zod |
| AI | Gemini API (`gemini-2.5-flash`) |
| Cache (opsional) | Redis |

## Struktur Project

```text
src/
  index.ts              # Entry point, health check, route registration
  config.ts             # Environment configuration
  middlewares/auth.ts   # JWT authenticate + role authorize
  routes/
    auth.ts             # Register & login
    projects.ts         # Project CRUD + list tasks
    ai-command.ts       # AI command + transaction + audit log
    audit-logs.ts       # Admin audit log viewer
  utils/ai.ts           # Gemini integration + JSON parsing
  redis.ts              # Optional Redis cache helper
prisma/
  schema.prisma         # Database models
  seed.ts               # Initial data
postman/                # API test collection
```

## Setup & Run

```bash
copy .env.example .env
npm install
npm run prisma:generate
npm run prisma:migrate -- --name init
npm run prisma:seed
npm run dev
```

Server: `http://localhost:3000`

## Environment

Contoh env ada di `.env.example`.

| Variabel | Wajib | Keterangan |
|----------|-------|------------|
| `DATABASE_URL` | ✅ | Koneksi PostgreSQL |
| `JWT_SECRET` | ✅ | Secret untuk sign JWT |
| `GEMINI_API_KEY` | ✅* | Wajib untuk test AI command |
| `GEMINI_MODEL` | - | Default: `gemini-2.5-flash` |
| `REDIS_URL` | - | Opsional; kosongkan jika Redis tidak dipakai |
| `PORT` | - | Default: `3000` |

## Akun Seeder

| Role | Email | Password |
|------|-------|----------|
| Admin | `admin@yapindo.local` | `admin123` |
| User | `budi@yapindo.local` | `user123` |

## Endpoint

### Auth (public)

- `POST /register` — daftar user/admin
- `POST /login` — dapatkan JWT token

### Project (butuh token)

| Endpoint | Admin | User |
|----------|-------|------|
| `GET /projects` | ✅ | ✅ |
| `GET /projects/:id` | ✅ | ✅ |
| `POST /projects` | ✅ | ❌ |
| `PUT /projects/:id` | ✅ | ❌ |
| `DELETE /projects/:id` | ✅ | ❌ |
| `GET /projects/:id/tasks` | ✅ | ✅ |

## Postman

Import:

- `postman/Yapindo-Technical-Test.postman_collection.json`
- `postman/Yapindo-Technical-Test.postman_environment.json`

Urutan test:

1. `Login Admin` (token otomatis tersimpan)
2. `Get Projects` → `Create Project` → `Get Project Tasks`
3. `AI Command`

Detail endpoint AI & monitoring ada di `README_PERSONAL.md`.

Collection sudah berisi test assertions otomatis.

## Prompt AI Design

System prompt memaksa Gemini mengembalikan **raw JSON** dengan array `actions` berisi operasi `create`, `update`, atau `delete` pada tabel `Task` saja.

Lapisan keamanan AI:

1. **Guardrail prompt** — tolak instruksi mutasi tabel `User`
2. **Parser defensif** — ekstrak JSON dari respons (termasuk jika dibungkus markdown)
3. **Validasi Zod** — pastikan struktur JSON valid sebelum eksekusi DB
4. **Transaction** — semua aksi dalam satu request atomic (rollback jika gagal)
5. **Audit log** — setiap request AI tercatat (sukses/gagal)


