# DARK MNMLL PULSE OS × AZRAIL — canonical UI reference

## Canva v2

Canonical design ID: `DAHWmV1b58E`  
Canva link: https://canva.link/mcn8pkbguawi58b

Этот дизайн — визуальный reference. Runtime source of truth остаётся в GitHub.

## Каноническая модель интерфейса

### Primary path

```text
CREATE
  ↓
Composer: «Что создать?»
  ↓
Project
  ↓
Mission
  ↓
UNDERSTAND → ARCHITECTURE → EXECUTE → VERIFY → RESULT
```

### Navigation

```text
CREATE
STUDIO
PROJECTS
LABS

ADVANCED
LEGACY
```

### Globe

- background system object, не отдельный dashboard;
- медленное вращение;
- три системных кольца;
- live regional presence;
- reduced-motion;
- mobile low-cost profile;
- Three.js загружается отдельным bundle.

### Projects

Project — верхний объект пользовательской работы:

- Files;
- Memory;
- Versions;
- History;
- Missions;
- Deployments;
- effective capabilities.

### Studio / Labs

Studio и Lab не создают отдельные orchestrators.

Они задают:
- prompt context;
- routing mode;
- capability domain.

Исполнение всегда идёт через один AZRAIL Orchestrator.

### Advanced

Advanced показывает только реальные серверные данные:

- model calls;
- mean latency;
- measured cost;
- unknown-cost caveat;
- budgets;
- write quota;
- top models;
- effective `git / deploy / sandbox / qa` permissions.

Запрещены декоративные fake metrics.

### Legacy

`ultimate.html` сохраняется как fallback/advanced legacy workspace до завершения миграции. Он не является основным UX.

## Design tokens

Каноническое направление:

- near-black / deep space;
- restrained violet accent;
- generous spacing;
- understated borders;
- glass only where it improves hierarchy;
- large typography;
- one dominant action per screen.

## Source-of-truth files

```text
public/pulse.html
public/pulse.js
public/pulse-globe.html
src/ui/pulse-globe.ts
public/pulse-studios.json
src/protocol/mission.ts
src/protocol/project.ts
src/protocol/facade.ts
```

Canva используется для визуального контроля. Любая новая UI-функция сначала должна соответствовать архитектурным границам кода, а затем визуальному reference.
