# opencode-v2-mcp

MCP-сервер, который позволяет Claude Code (или любому другому MCP-клиенту)
делегировать выполнение ограниченных задач по написанию кода локальному
[OpenCode](https://opencode.ai) **v2.x**. Один инструмент — `opencode_execute` —
запускает `opencode run --format json`, парсит NDJSON-вывод и возвращает
компактный отчёт: текст ответа, `git diff --stat`, `git status --short`,
код возврата и `sessionID`.

Написан по мотивам референсной реализации из community-инструкции
«Claude Code Desktop → OpenCode v2 как субагент-исполнитель кода» и
доработан тремя фиксами, без которых обёртка не работает с реальной
установкой `opencode v2.0.12` (подробности — раздел «Известные баги
экосистемы» ниже).

## Требования

- **OpenCode v2.x**, установленный и доступный в `PATH` (`opencode --version`
  должен показывать `2.x`).
- Node.js 18+.
- Настроенный провайдер/модель в OpenCode (`opencode auth login`,
  `opencode auth list`).
- Проект, где будет выполняться `opencode_execute`, должен содержать
  `opencode.json` с **JSON-блоком `agent`** (см. ниже — markdown-агенты
  `.opencode/agent/*.md` в этой версии зависают).

## Установка

```bash
git clone git@github.com:yuriisamohvalov-creator/opencode-mcp.git ~/tools/opencode-mcp
cd ~/tools/opencode-mcp
npm install
```

## Подключение к Claude Code

```bash
NODE_BIN="$(which node)"
claude mcp add --scope user opencode-v2 -- "$NODE_BIN" "$HOME/tools/opencode-mcp/server.mjs"
```

Если для выхода в интернет (облачные провайдеры моделей) нужен прокси —
передайте его переменными окружения при регистрации, они наследуются
дочерним процессом `opencode`:

```bash
claude mcp add --scope user opencode-v2 \
  -e HTTPS_PROXY=http://127.0.0.1:10808 -e HTTP_PROXY=http://127.0.0.1:10808 \
  -- "$NODE_BIN" "$HOME/tools/opencode-mcp/server.mjs"
```

Проверка:

```bash
claude mcp get opencode-v2
# Status: ✔ Connected
```

После подключения новой сессии Claude Code (или рестарта текущей)
инструмент `opencode_execute` доступен как `mcp__opencode-v2__opencode_execute`.

## Конфигурация проекта — только JSON-агент

В корне проекта, где будет работать `opencode_execute`, создайте
`opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "agent": {
    "claude-worker": {
      "description": "Implements a bounded coding task delegated by Claude Code",
      "mode": "primary",
      "prompt": "You are an implementation worker. Work only inside the current project. Make the smallest coherent change. Run relevant tests. Never commit, push, or delete broad paths. End with a concise summary."
    }
  }
}
```

**Не используйте markdown-файлы агентов** (`.opencode/agent/<name>.md`) —
в установленной `opencode v2.0.12` они приводят к зависанию `opencode run`
без единой строки вывода, воспроизведено многократно с разным содержимым
frontmatter. JSON-агент через `opencode.json` работает надёжно.

## Использование инструмента

```jsonc
{
  "task": "Add a slugify() helper in src/lib/slug.ts with tests. Acceptance: kebab-case, trims whitespace. Verify with `npm test -- slug`.",
  "cwd": "/absolute/path/to/project",
  "agent": "claude-worker",
  "model": "openai/gpt-5.5",       // опционально, provider/model
  "timeoutMs": 900000               // опционально, по умолчанию 15 минут
}
```

Ответ:

```jsonc
{
  "ok": true,
  "exitCode": 0,
  "sessionID": "ses_...",
  "text": "...финальный ответ модели...",
  "diffStat": "...git diff --stat...",
  "statusShort": "...git status --short..."
}
```

## Известные баги экосистемы, исправленные в этой обёртке

Референсная реализация, взятая за основу, не работала «из коробки» против
`opencode v2.0.12`. Три причины и фиксы:

1. **Отсутствовал флаг `--auto`.** Без него `opencode` не может
   неинтерактивно подтверждать edit/shell-разрешения — добавлен в
   `runOpenCode()` безусловно.
2. **`spawn("opencode", ...)` без абсолютного пути.** GUI-приложения
   (включая Claude Code Desktop) не всегда наследуют пользовательский
   `PATH`, где установлен `opencode` — используется абсолютный путь к
   бинарнику. **Проверьте и при необходимости поправьте путь в
   `server.mjs`** (`spawn("/home/USER/.opencode/bin/opencode", ...)`) под
   вашу установку — `which opencode` подскажет актуальный путь.
3. **`opencode v2` резолвит текущий проект через переменную окружения
   `$PWD`, а не через реальный `cwd` процесса.** `child_process.spawn()`
   в Node корректно меняет OS-уровневый `cwd` дочернего процесса, но НЕ
   обновляет `PWD` в его `env` — без явного `env: { ...process.env, PWD:
   input.cwd }` `opencode` не находит определённого в `opencode.json`
   агента и падает с `"Agent not found"`. Это не специфично для данной
   обёртки — баг актуален для любой Node/Bun-обёртки вокруг `opencode run`,
   использующей `spawn()` с `cwd`.

## Ограничения

- Одна задача — один запуск `opencode run`, без параллелизма в рамках
  одного вызова инструмента.
- Инструмент не проверяет `permission`-конфигурацию OpenCode сам — если
  агент запрещает нужную команду, `opencode run` завершится без изменений
  и с пустым `text`; смотрите `stderrTail`/`exitCode` в ответе.
- Не подменяет ревью: вызывающая сторона должна самостоятельно проверять
  `diffStat`/`statusShort` и результаты тестов, а не доверять только полю
  `ok`.
