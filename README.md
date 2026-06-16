# MaaS MVP - Memory as a Service

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.0-blue?style=for-the-badge&logo=semver&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-316192?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![OpenAI](https://img.shields.io/badge/OpenAI-412991?style=for-the-badge&logo=openai&logoColor=white)](https://openai.com/)

[![Status](https://img.shields.io/badge/Status-MVP-success?style=for-the-badge)](https://github.com/alexeykrol/MaaS)
[![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](LICENSE)
[![Event-Driven](https://img.shields.io/badge/Architecture-Event--Driven-orange?style=for-the-badge)](ARCHITECTURE.md)
[![Tests](https://img.shields.io/badge/Tests-Passing-brightgreen?style=for-the-badge)](scripts/)

</div>

---

**Event-Driven AI System with Long-term Semantic Memory**

> 🧠 Building an AI that remembers: A memory-as-a-service system powered by PostgreSQL event-driven architecture and OpenAI.

## ✨ Key Features

- 🧠 **Long-term Memory**: LSM storage with semantic tags and time-bucketed summaries
- ⚡ **Event-Driven**: PostgreSQL LISTEN/NOTIFY for real-time agent coordination
- 🔄 **Auto-Summarization**: Archivist agent converts conversation logs to compressed memories
- 🎯 **Context Assembly**: Smart context building from LSM + recent conversations
- 🤖 **OpenAI Integration**: GPT-4o-mini powered responses with full memory context
- 📊 **Blackboard Pattern**: Agents communicate through shared database state
- ✅ **Fully Tested**: End-to-end tests validate complete memory cycle
- 🔒 **Idempotent**: Safe task processing with automatic retries

## Architecture Overview

- **Event-Driven System**: PostgreSQL LISTEN/NOTIFY for module communication
- **Blackboard Pattern**: Modules communicate via shared database state
- **State Machine**: Pipeline status transitions (NEW → ANALYZING → ANALYZED → READY → COMPLETED)
- **Test-First Approach**: Test Runner validates each module incrementally

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Database**: Supabase (PostgreSQL managed)
- **LLM**: OpenAI API (gpt-4o-mini / gpt-4o)
- **HTTP Server**: Express

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Create `.env` file from template:

```bash
cp .env.example .env
```

Edit `.env` and add your credentials:

```env
DATABASE_URL=postgresql://postgres:[PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres
DATABASE_SSL=true
OPENAI_API_KEY=sk-...
PORT=3000
TEST_USER_ID=00000000-0000-0000-0000-000000000000
```

For local PostgreSQL instead of Supabase:

```bash
npm run db:local:up
```

```env
DATABASE_URL=postgresql://maas:maas@localhost:5432/maas
DATABASE_SSL=false
OPENAI_API_KEY=sk-...
PORT=3000
TEST_USER_ID=00000000-0000-0000-0000-000000000000
```

### 3. Test Database Connection

```bash
npm run db:test
```

Expected output:
```
✅ Database connection successful!
   Server time: 2025-11-25 12:00:00
   PostgreSQL version: PostgreSQL 15.x
```

### 4. Create Database Schema

```bash
npm run db:migrate
```

## Project Structure

```
MaaS2/
├── src/
│   ├── agents/          # Agent modules (Analyzer, Assembler, Responder)
│   ├── orchestrator/    # LISTEN/NOTIFY event coordinator
│   ├── test-runner/     # Test framework with mock mode
│   ├── utils/           # Shared utilities (db, logger)
│   └── server.ts        # Main HTTP server
├── db/
│   ├── schema.sql       # Database schema (6 tables + triggers)
│   └── seeds.sql        # Initial data (system_prompts, test scenarios)
├── public/
│   └── test-runner/     # Test Runner UI
└── dist/                # Compiled JavaScript (generated)
```

## Development Workflow

### Phase 1: MVP (Backend) ✅ COMPLETED

> **Status:** 100% (12/12 steps) — End-to-end pipeline working!

All MVP steps completed:
- ✅ Steps 0-2: Infrastructure (DB, Test Runner)
- ✅ Steps 3-5: Orchestrator, Agent Stubs, Logger
- ✅ Steps 6-8: Real Analyzer, Assembler, FinalResponder
- ✅ Steps 9-11: Archivist, Assembler v2, Polish

### Phase 2: Self-Learning System 🔜 NEXT

> **Goal:** MaaS evaluates itself and improves automatically through experiments.

**Key insight:** Measurement is built into Self-Learning:
- **Teacher** = LLM-Judge (quality evaluation)
- **User Emulator** = Golden Dataset generator
- **Manager** = Metrics Dashboard

| Step | Component | What it does |
|------|-----------|--------------|
| 12 | Telemetry | Collect metrics (latency, tokens, hit_rate) |
| 13 | Tuner | Apply/rollback parameters safely |
| 14 | User Emulator | Generate test dialogs (scenarios, personas) |
| 15 | Teacher | Quality evaluation + hypotheses (LLM-Judge) |
| 16 | Manager | Coordinate learning cycle, generate reports |

**Details:** See [ROADMAP.md](./ROADMAP.md), [docs/selflearn/](./docs/selflearn/README.md)

### Phase 4: Frontend Integration (Post-MVP) - **27-36 hours**

> **Note**: Frontend is added AFTER MVP completion. MVP is a pure backend system.

#### Architecture
```
┌─────────────────────┐         ┌─────────────────────┐
│  Frontend (React)   │         │  Backend (Node.js)  │
│                     │         │                     │
│  Supabase SDK:      │         │  Direct Postgres:   │
│  • Auth             │         │  • LISTEN/NOTIFY    │
│  • Realtime         │         │  • Orchestrator     │
│  • Storage          │         │  • Agents           │
│  • RLS              │         │  • Triggers         │
│                     │         │                     │
│  SUPABASE_URL       │         │  DATABASE_URL       │
│  ANON_KEY           │         │                     │
└─────────────────────┘         └─────────────────────┘
         ↓                               ↓
    ┌─────────────────────────────────────────┐
    │      Supabase PostgreSQL Database       │
    └─────────────────────────────────────────┘
```

#### Frontend Steps
13. **Step 12**: Frontend Setup (React + Vite + Supabase SDK)
14. **Step 13**: Authentication UI (Login/Signup via Supabase Auth)
15. **Step 14**: Chat Interface (message list + input + markdown)
16. **Step 15**: Realtime Updates (live status via Supabase Realtime)
17. **Step 16**: History & Search (infinite scroll + filters)
18. **Step 17**: Admin Panel (metrics + prompt management)
19. **Step 18**: Polish & Deploy (mobile + dark mode + production)

#### Why Two Approaches?
- **Frontend** needs: Auth, Realtime, RLS → Supabase SDK
- **Backend** needs: LISTEN/NOTIFY, Triggers → Direct PostgreSQL
- Both connect to the **same database**, different methods

## Running the System

### Start Orchestrator (Event Listener)

```bash
npm run orchestrator
```

### Start HTTP Server

```bash
npm run dev
```

### Run Test Runner

```bash
# CLI
npm run test-runner

# Web UI
open http://localhost:3000/test-runner
```

## Testing Approach

**Test-First Development**: Test Runner is built FIRST with mock mode to validate the event-driven pipeline before implementing real logic.

1. **Step 2**: Test Runner with mock responses (self-contained test)
2. **Step 3**: Orchestrator - see NOTIFY events in logs
3. **Step 4**: Agent Stubs - full pipeline with fake responses
4. **Steps 5-11**: Replace stubs with real implementations one by one

Each module is validated with Test Runner before moving to the next step.

## Documentation

- **[ARCHITECTURE.md](./ARCHITECTURE.md)**: System architecture (modules, requirements, interfaces)
- **[PIPELINE.md](./PIPELINE.md)**: Processes and interactions (state machine, triggers, flows)
- **[BACKLOG.md](./BACKLOG.md)**: Development plan (Phase 1-3, all steps with checklists)
- **[ROADMAP.md](./ROADMAP.md)**: Prioritized roadmap (what to do next)
- **[docs/selflearn/](./docs/selflearn/README.md)**: Self-learning system (roles, cycles, experiments)

## License

MIT
