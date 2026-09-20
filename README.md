# Godville Agent

Локальный TypeScript-советник для одного героя. По умолчанию он запускается в `advisor`/dry-run режиме: хранит наблюдения официального API, версионированные знания и воспроизводимые рекомендации в SQLite. Он не выполняет вход, не сканирует игровые страницы и не отправляет игровые действия.

Публичные правила Godville запрещают автоматизацию игры. Поэтому готовность этого кода не является разрешением на эксплуатацию и не обещает отсутствие санкций или игровой результат.

## Запуск

Нужен Node 24 LTS. Скопируйте [пример настроек](examples/agent.env.example), задайте `GODVILLE_DATA_DIR`, затем:

```sh
npm install
npm run check && npm test
npm run dev -- daemon --once
npm run dev -- status
```

Для официального read-only API укажите имя бога и путь к смонтированному файлу токена; токен не передаётся в аргументах, не логируется и не сохраняется в БД. Опрос ограничен минимумом 60 секунд. Полезные команды: `daemon [--once]`, `status`, `knowledge`, `import-snapshot FILE`, `priorities VERSION '["pension","ark"]'`, `backup FILE`.

Docker-образ запускает тот же offline dry-run: `docker compose run --rm agent`. Compose использует named volume `godville-data`, поэтому стартует без ручной правки владельца каталога. Контейнер работает не-root пользователем с read-only корневой файловой системой. `Dockerfile.browser` — отдельный Debian/Chromium образ для opt-in Playwright adapter; он не содержит логина и по умолчанию выполняет только `browser-check` каталога.

Проверить полный локальный browser pipeline можно без сети: `GODVILLE_BROWSER_ENABLED=true GODVILLE_BROWSER_MANIFEST=config/handlers.fixture.json npm run dev -- browser-run fixture.confirm 1`. Для удалённого URL дополнительно требуется `GODVILLE_BROWSER_ALLOW_REMOTE=true`; без захваченной и проверенной DOM-фикстуры Godville такая попытка остановится, а не выберет селектор самостоятельно. Полный контракт и границы реализации: [docs/specs/godville-agent/07-implementation-contract.md](docs/specs/godville-agent/07-implementation-contract.md).

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
