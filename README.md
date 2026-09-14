# Folio3 ATS — Interview Tracking Automation

An automated Applicant Tracking System (ATS) backend that monitors Google Calendar for interview events, uses AI to classify and extract structured interview data, downloads and parses candidate resumes, and syncs everything into a Google Sheet — eliminating manual tracking of the interview pipeline.

## What It Does

This service watches a Google Calendar for interview-related events and, without any manual data entry, produces a fully structured, up-to-date interview tracker in Google Sheets. The pipeline runs end-to-end automatically:

**Calendar → AI Classification → Resume Download → AI Resume Parsing → Google Sheets Sync**

Built for HR and recruitment teams who schedule interviews via Google Calendar and need a single source of truth for candidate status, without maintaining it by hand.

## How It Works

1. **Calendar Monitoring** — Polls the primary Google Calendar for recent events within a configurable time window.
2. **AI Event Classification** — Sends batches of events to Groq's LLM (`openai/gpt-oss-120b`) to semantically determine whether each event is an interview, and extracts details like position, interview stage, type (online/onsite/phone), interviewers, and recruiter.
3. **Resume Retrieval** — Downloads attached resumes from Google Drive (supports Google Docs, PDF, DOCX, and DOC formats).
4. **AI Resume Parsing** — Extracts candidate name, email, and phone number from resume text using Groq.
5. **Sheet Sync** — Upserts the combined data into a Google Sheet, keyed by calendar event ID, keeping rows sorted chronologically by interview date.

This entire flow runs automatically on a schedule (see [Tracker Service](#key-modules)), and can also be triggered manually via a test endpoint.

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (v20+) |
| Language | TypeScript |
| Framework | NestJS (Express under the hood) |
| AI / LLM | Groq API — `openai/gpt-oss-120b`, `llama-3.3-70b-versatile` |
| Google APIs | Calendar API v3, Drive API v3, Sheets API v4 |
| Document Parsing | `pdf-parse`, `mammoth` (DOCX), `word-extractor` (DOC) |
| Scheduling | `@nestjs/schedule` |
| Config | `@nestjs/config` (`.env`) |
| Testing | Jest, Supertest |
| Data Store | Google Sheets (no traditional database) |

## Project Structure

```
src/
├── main.ts                    # App bootstrap, CORS, port 3000
├── app.module.ts              # Root module
├── app.controller.ts          # Root routes incl. manual pipeline trigger
│
├── google-auth/               # Shared Google OAuth2 client (global module)
├── calendar/                  # Calendar fetching + AI event classification
├── drive/                     # Resume download/upload, text extraction
├── sheets/                    # Google Sheets read/write, upsert logic
├── tracker/                   # Orchestrates the full sync pipeline
│   └── resume-parser.service.ts  # AI resume field extraction
│
└── interview-parser/          # ⚠️ Orphaned module, not currently wired in
```

## Key Modules

- **`calendar.service.ts`** — Core AI classification logic (~674 lines). Handles Groq API key rotation, rate-limit retries with backoff, and structured field extraction from event descriptions.
- **`tracker.service.ts`** — Runs the full sync pipeline on startup and on an interval. Includes a lock to prevent overlapping runs and cleans up temp files after each pass.
- **`sheets.service.ts`** — Manages the 15-column tracker sheet (Candidate Name, Position, Stage, Type, Date, Time, Location, Interviewers, Recruiter, Contact, Email, Resume Link, Event ID, Status, Updated At).
- **`drive.service.ts`** — Handles multiple Drive URL formats and file types, with basic integrity checks on downloaded files.

## Setup & Installation

### Prerequisites

- Node.js v20+
- Google Cloud project with **Calendar API**, **Drive API**, and **Sheets API** enabled
- OAuth2 credentials (or a Service Account) for Google APIs
- A Groq API account with at least one API key

### Install

```bash
npm install
```

> Note: `.npmrc` sets `legacy-peer-deps=true`.

### Environment Variables

Create a `.env` file with the following (the committed `.env.example` is incomplete — this is the full list currently required by the code):

```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
GOOGLE_SHEET_ID=
GOOGLE_SHEET_NAME=
GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH=
GOOGLE_DRIVE_FOLDER_ID=
HR_SCHEDULING_EMAIL=
GROQ_API_KEY=
GROQ_API_KEY_2=
RECENT_WINDOW_MINUTES=15
```

## Running the App

```bash
# Development (watch mode)
npm run start:dev

# Development (one-shot)
npm run start

# Debug mode
npm run start:debug

# Production build
npm run build
npm run start:prod
```

Server runs on **port 3000** by default.

### Testing & Linting

```bash
npm run test        # unit tests
npm run test:e2e    # e2e tests
npm run test:cov    # coverage
npm run lint
npm run format
```

## API Endpoints

| Method | Route | Description |
|---|---|---|
| `GET` | `/` | Health check |
| `GET` | `/test-full-flow` | Manually triggers the full sync pipeline (debugging) |
| `GET` | `/calendar/events?from=&to=` | Returns calendar events as JSON, or an HTML live dashboard (`Accept: text/html`) |
| `POST` | `/sheets/sync` | Manually triggers a sheet sync |

Most functionality runs automatically via the scheduled `TrackerService` rather than through these endpoints — the endpoints are primarily for manual testing and monitoring.

## Data Store

There is currently **no traditional database**. The Google Sheet itself acts as the system of record, with row-level upsert logic keyed by calendar event ID. There are no migrations or seeders since the schema is just the sheet's header row.

## Known Limitations & Cleanup Opportunities

These are worth addressing as the project matures:

- **No authentication/authorization** — all endpoints are currently publicly accessible.
- **`.env.example` is incomplete** — only lists a fraction of the required variables; the app will fail to start without the full set above.
- **Dead code**: the `@google/generative-ai` package and `interview-parser/` module are unused leftovers from an earlier Gemini-based implementation and are not wired into the app.
- **Several installed npm packages are unused**: `@icetee/nest-google-sheet-connector`, `@miinded/nestjs-google-drive`, `@qte/nest-google-calendar`.
- **`word-extractor`** is used at runtime in `drive.service.ts` but isn't listed in `package.json` — `.doc` file parsing will fail unless it's installed separately.
- **TypeScript strictness is relaxed** (`strictNullChecks: false`, `noImplicitAny: false`), and DTOs lack request validation (`class-validator`).
- **Minimal test coverage** — only the default NestJS boilerplate e2e test currently exists.
- **No Docker or CI/CD configuration** at present.

## License

_Add license information here._
