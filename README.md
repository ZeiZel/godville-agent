# Godville Agent

Локальный TypeScript-советник для одного героя. По умолчанию он запускается в `advisor`/dry-run режиме: хранит наблюдения официального API, версионированные знания и воспроизводимые рекомендации в SQLite. Он не выполняет вход, не сканирует игровые страницы и не отправляет игровые действия.

Публичные правила Godville запрещают автоматизацию игры. Поэтому готовность этого кода не является разрешением на эксплуатацию и не обещает отсутствие санкций или игровой результат.

## Запуск

Нужен Node 24 LTS. Скопируйте [пример настроек](.env.example) в локальный `.env`, затем выполните:

```sh
npm install
npm run check && npm test
npm run dev -- daemon --once
npm run dev -- status
```

Для официального read-only API укажите имя бога и путь к смонтированному файлу токена; токен не передаётся в аргументах, не логируется и не сохраняется в БД. Опрос ограничен минимумом 60 секунд. Полезные команды: `daemon [--once]`, `status`, `knowledge`, `import-snapshot FILE`, `priorities VERSION '["pension","ark"]'`, `backup FILE`, `browser-check`, `browser-inspect` и `browser-run HANDLER VERSION [URL]`.

### Переменные запуска

`npm run dev` и `npm start` используют нативный Node `--env-file-if-exists=.env`; отсутствующий `.env` не является ошибкой. Docker получает явно заданные переменные из Compose. Можно и экспортировать значения в оболочке.

| Переменная | Эффект |
| --- | --- |
| `GODVILLE_DATA_DIR` | Каталог SQLite; по умолчанию `./data`. |
| `GODVILLE_MODE` | `advisor` по умолчанию; `browser` требует `GODVILLE_BROWSER_ENABLED=true`. Сам по себе режим не запускает browser-команду. |
| `GODVILLE_GOD_NAME`, `GODVILLE_TOKEN_FILE` | Включают официальный read-only API и задают путь к файлу токена. |
| `GODVILLE_API_INTERVAL_SECONDS` | Интервал daemon API, не менее 60; по умолчанию 75. |
| `GODVILLE_RESERVE_CHARGES`, `GODVILLE_MAX_CHARGES_PER_DAY`, `GODVILLE_MAX_CHARGES_PER_7D`, `GODVILLE_MAX_CHARGES_PER_EXPEDITION` | Локальные лимиты журнала зарядов. |
| `GODVILLE_ZPG_ENABLED`, `GODVILLE_ZPG_CONFIRMATION`, `GODVILLE_ZPG_MIN_OFFSET_SECONDS`, `GODVILLE_ZPG_MAX_OFFSET_SECONDS` | Включают и ограничивают планировщик ZPG. |
| `GODVILLE_BROWSER_ENABLED`, `GODVILLE_BROWSER_MANIFEST` | Требуются для проверки и запуска versioned handler catalog. |
| `GODVILLE_BROWSER_STATE_DIR`, `GODVILLE_BROWSER_HEADLESS`, `GODVILLE_BROWSER_ALLOW_REMOTE` | Persistent Playwright profile, headless режим (всё кроме `false` означает `true`) и явное разрешение удалённого URL. |
| `GODVILLE_ORCA_PAGE_ID`, `GODVILLE_ORCA_COMMAND` | Read-only диагностика существующей Orca-страницы; команда ограничена `orca` или `orca-dev`. |

Docker-образ запускает тот же offline dry-run: `docker compose run --rm agent`. Compose использует named volume `godville-data`, поэтому стартует без ручной правки владельца каталога. Контейнер работает не-root пользователем с read-only корневой файловой системой. `Dockerfile.browser` — отдельный Debian/Chromium образ для opt-in Playwright adapter; он не содержит логина и по умолчанию выполняет только `browser-check` каталога.

Для локального `browser-run` установите Chromium один раз: `npx playwright install chromium`. `browser-inspect` использует установленный на хосте `orca` или `orca-dev`; этот CLI не входит в Docker-образы проекта.

Проверить полный локальный browser pipeline можно без сети: `GODVILLE_BROWSER_ENABLED=true GODVILLE_BROWSER_MANIFEST=config/handlers.fixture.json npm run dev -- browser-run fixture.confirm 1`. Для удалённого URL дополнительно требуется `GODVILLE_BROWSER_ALLOW_REMOTE=true`; без захваченной и проверенной DOM-фикстуры Godville такая попытка остановится, а не выберет селектор самостоятельно. Полный контракт и границы реализации: [docs/specs/godville-agent/07-implementation-contract.md](docs/specs/godville-agent/07-implementation-contract.md).

`browser-inspect` работает только с уже открытой Orca page ID. На `/login` он сообщает `auth_required`; на `/superhero` без password-поля, но без `data-agent-observation`, сообщает `authenticated_but_adapter_missing`. Это диагностика структуры страницы, а не готовность executor-а.

## Что реализовано

| Возможность | Статус |
| --- | --- |
| SQLite WAL: наблюдения, знания, решения, операции, cooldown, charge ledger, версионированные priorities/settings | Реализовано |
| Резерв зарядов ≥100, дневной/недельный/экспедиционный лимиты, lease и журнал восстановления | Реализовано и тестируется |
| API-нормализация documented fields, auth/expiry degradation, API pacing | Реализовано |
| DAG храм → ковчег → пары → личный босс → книга → души; храм → пенсия → лавка; лавка+души → реликварий | Реализовано |
| Безопасные чистые решения для подземелья, моря, полигона и инвентаря | Реализовано на локальных фикстурах |
| ZPG-планировщик | Реализован как совет: только окно часа, свежая проверка, cooldown, без fallback на обычную арену, голосов и ожидаемой награды зарядом |
| Browser/Playwright adapter | Отдельный opt-in контракт с точными role/text handlers, pre/postconditions и атомарным journal gate. Реальные Godville-селекторы и UI-observer не поставляются, пока нет проверенной UI-фикстуры; интеграция с реальной игрой остаётся незавершённой |

Каталог знаний — проверенный файл в репозитории; он не сканирует wiki автоматически. Неизвестный UI, режим, карта, цена или баланс приводит к `Observe`/`NoOp`, а не к догадке.

Идентификатор browser intent строится из героя, версии handler-а и устойчивого идентификатора события: час UTC для ZPG и локальный fixture event для теста. Для другого действия без подтверждённого event id actor завершится до клика. ZPG cooldown записывается только из подтверждённого UI-наблюдения, а не по предполагаемой награде или фиксированному времени.
