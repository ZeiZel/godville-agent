# Godville Agent

## Локальный dashboard

Для просмотра последних наблюдений и действий агента запустите локальный интерфейс:

```sh
bun run start dashboard
```

По умолчанию он доступен только на `http://127.0.0.1:3210/`. Путь к журналам можно задать через `GODVILLE_LOG_DIR`; по умолчанию используется `data/automation/logs`. Интерфейс только читает состояние и не содержит игровых команд.

Локальный Bun/TypeScript-советник для одного героя. По умолчанию он работает в `advisor`/dry-run: хранит наблюдения, версионированные знания и воспроизводимые рекомендации в SQLite. Команды браузера включаются явно; `live run --once` подходит для одной проверки, а запуск без `--once` работает непрерывно.

## Запуск

Нужен Bun 1.4.2. Скопируйте [пример настроек](.env.example) в локальный `.env`, затем выполните:

```sh
bun install
bun run check && bun test
bun run dev -- daemon --once
bun run dev -- status
```

Bun загружает `.env`, если файл существует. В Docker передавайте переменные явно через Compose. Токен официального API передаётся только как путь к смонтированному файлу: он не попадает в argv, журнал или SQLite. Опрос API ограничен минимумом 60 секунд.

Полезные команды: `daemon [--once]`, `status`, `knowledge`, `import-snapshot FILE`, `priorities VERSION '["pension","ark"]'`, `backup FILE`, `browser-check`, `browser-inspect`, `browser-run HANDLER VERSION [URL]` и `live observe|plan|run [--once]`.

### Переменные запуска

| Переменная | Эффект |
| --- | --- |
| `GODVILLE_DATA_DIR` | Каталог SQLite; по умолчанию `./data`. |
| `GODVILLE_MODE` | `advisor` по умолчанию. `browser` вместе с `GODVILLE_BROWSER_ENABLED=true` требуется для `live run`. Сам режим не запускает браузер. |
| `GODVILLE_GOD_NAME`, `GODVILLE_TOKEN_FILE` | Имя героя для read-only API и доверенная identity для live-run; путь к файлу API-токена. |
| `GODVILLE_API_INTERVAL_SECONDS` | Интервал daemon API, не менее 60 секунд; по умолчанию 75. |
| `GODVILLE_RESERVE_CHARGES`, `GODVILLE_MAX_CHARGES_PER_DAY`, `GODVILLE_MAX_CHARGES_PER_7D`, `GODVILLE_MAX_CHARGES_PER_EXPEDITION` | Локальные лимиты журнала зарядов. Резерв не может быть ниже 100. |
| `GODVILLE_ZPG_ENABLED`, `GODVILLE_ZPG_CONFIRMATION`, `GODVILLE_ZPG_MIN_OFFSET_SECONDS`, `GODVILLE_ZPG_MAX_OFFSET_SECONDS` | Включают и ограничивают планировщик ZPG: цель — первое окно часа, безопасный default `5..160` секунд (не позднее 02:40). |
| `GODVILLE_BROWSER_ENABLED`, `GODVILLE_BROWSER_MANIFEST` | Включают versioned handler catalog для `browser-check` и `browser-run`. |
| `GODVILLE_BROWSER_STATE_DIR`, `GODVILLE_BROWSER_HEADLESS`, `GODVILLE_BROWSER_ALLOW_REMOTE` | Persistent Playwright profile, headless режим и явное разрешение удалённого URL. |
| `GODVILLE_LIVE_POLICY_FILE` | Путь к строгой JSON-политике для `live plan` и `live run`. |
| `GODVILLE_ORCA_PAGE_ID`, `GODVILLE_ORCA_COMMAND` | Идентификатор уже открытой Orca page и команда `orca` либо `orca-dev`; применяются к `browser-inspect` и live adapter. |

Docker-образ запускает тот же offline dry-run: `docker compose run --rm agent`. Compose использует named volume `godville-data`, поэтому стартует без ручной правки владельца каталога. Контейнер работает не-root пользователем с read-only корневой файловой системой. [browser.Dockerfile](browser.Dockerfile) — отдельный Bun/Chromium образ для opt-in Playwright adapter; он не содержит логина и по умолчанию выполняет только `browser-check` каталога.

Для локального `browser-run` установите Chromium один раз: `bunx playwright install chromium`. `browser-inspect` и live Orca adapter используют установленный на хосте `orca` или `orca-dev`; этот CLI не входит в Docker-образы проекта.

Проверить локальный Playwright pipeline можно без сети:

```sh
GODVILLE_BROWSER_ENABLED=true GODVILLE_BROWSER_MANIFEST=config/handlers.fixture.json \
  bun run dev -- browser-run fixture.confirm 1
```

Для удалённого URL дополнительно нужен `GODVILLE_BROWSER_ALLOW_REMOTE=true`. Без захваченной и проверенной DOM-фикстуры Godville адаптер останавливается и не выбирает селектор самостоятельно.

## Live JSON policy

`config/live-policy.example.json` содержит только whitelist полей наблюдения, сравнений и reviewed command IDs. В ней нельзя определить селектор, URL, JavaScript или стоимость. Safety rule имеет приоритет над weight; затем планировщик детерминированно выбирает максимальные `priority`, `weight` и порядок в файле. Для диагностического и планового запуска:

```sh
GODVILLE_LIVE_POLICY_FILE=config/live-policy.example.json \
  bun run dev -- live observe
GODVILLE_LIVE_POLICY_FILE=config/live-policy.example.json \
  bun run dev -- live plan
GODVILLE_LIVE_POLICY_FILE=config/live-policy.example.json \
  bun run dev -- live run --once --dry-run
```

`live run --once` требует `GODVILLE_MODE=browser`, `GODVILLE_BROWSER_ENABLED=true`, `GODVILLE_GOD_NAME`, policy file и Orca page ID. Без `--once` команда остаётся запущенной: в простое она опрашивает UI каждые 15 секунд, а при активности — через 3–5 секунд с jitter. Перед каждым кликом адаптер заново читает DOM, а runner повторно проверяет ту же политику, identity, stable diary event, lease и фиксированную стоимость. Решение, финальный снимок, policy hash и операция сохраняются в SQLite. Неоднозначный результат блокирует дальнейший одноимённый command до ручной сверки.

Поддержанные live commands: `hero.encourage` в обычном поле и активном подземелье, `hero.punish` и `arena.voice.heal`/`arena.voice.attack` в положительно подтверждённой обычной арене с условием трёх зарядов, `hero.restore_prana` (ровно 1 accumulator charge, до +50 prana), `adventure.dungeon.start`, `dungeon.move.auto`, `adventure.polygon.start`, `polygon.move.safe` и `arena.zpg.start`. Тактика обычной арены и её ограничения описаны в [09-arena-tactics.md](docs/specs/godville-agent/09-arena-tactics.md). Полигон стартует только при 80 prana, оставляя 30 prana на два контролируемых шага; `polygon.move.safe` допускает только соседние `ремкомплект` или `бит` при 15 prana и подтверждает тот же бой точным debit 15. Восстановление резервирует charge в SQLite до клика и никогда не пересекает reserve 100. Арена не выполняет recharge. Sailing, inventory, произвольные boss actions и неизвестные серверные confirmation prompts остаются observe-only/unsupported.

Orca live adapter работает на хосте и требует уже открытой authenticated Orca page ID. Docker-образ с optional Playwright/Chromium предназначен для отдельного browser-runtime и не предоставляет этот live adapter или открытую Orca-сессию.

`browser-inspect` работает только с уже открытой Orca page ID. На `/login` он сообщает `auth_required`; на `/superhero` без password-поля, но без `data-agent-observation`, сообщает `authenticated_but_adapter_missing`. Это диагностика структуры страницы, а не готовность executor-а.

## Что реализовано

| Возможность | Статус |
| --- | --- |
| SQLite WAL: наблюдения, знания, решения, операции, cooldown, charge ledger, версионированные priorities/settings | Реализовано |
| Резерв зарядов ≥100, дневной/недельный/экспедиционный лимиты, lease и журнал восстановления | Реализовано и тестируется |
| API-нормализация documented fields, auth/expiry degradation, API pacing | Реализовано |
| DAG храм → ковчег → пары → личный босс → книга → души; храм → пенсия → лавка; лавка+души → реликварий | Реализовано |
| Безопасные чистые решения для подземелья, моря, полигона и инвентаря | Реализовано на локальных фикстурах |
| ZPG-планировщик | Реализован в непрерывном host loop: окно часа, свежая проверка перед физическим кликом, durable lifecycle recovery, без fallback на обычную арену, голосов и ожидаемой награды зарядом |
| Playwright adapter | Отдельный opt-in контракт с точными role/text handlers, pre/postconditions и атомарным journal gate |
| Orca live adapter | Exact-control field/dungeon actions, verified ordinary-arena influence/voice, recharge, dungeon/polygon entry/navigation и ZPG start; sailing и inventory не реализованы |

Каталог знаний — проверенный файл в репозитории; он не сканирует wiki автоматически. Неизвестный UI, режим, карта, цена или баланс приводит к `Observe`/`NoOp`, а не к догадке.
