# Полный отказ от YAML — design

Дата: 2026-09-03

## Контекст

Исторически проект хранил данные в YAML-файлах (`topology.yaml`,
`subnets.yaml`, `rules.yaml`, `.firenet-layout.json`). Затем хранилище
переехало в PostgreSQL (`internal/pgstore`: версионирование + черновики),
но YAML остался в четырёх ролях:

1. **Legacy-импорт**: при первом запуске читаются корневые YAML-файлы и
   сеются как версия 1 (`internal/cli/legacy.go`, `internal/cli/serve.go`,
   `internal/httpapi/store.go` → `pgstore.SeedInitialVersion`).
2. **Вход CLI**: `firenet validate` и `firenet compile` принимают
   YAML-файлы флагами `--topology/--subnets/--rules`.
3. **Внутренний формат-посредник**: httpapi конвертирует `ProjectDoc`
   (структуры из БД) в YAML-байты и обратно через `app.LoadProject` /
   `rules.Load` (`internal/httpapi/handlers.go`, 17 вызовов `yaml.*`).
4. **Парсеры**: `internal/topology/load.go` и `internal/rules/load.go`
   держат YAML-структуры и декодеры; `internal/projectdoc` хранит
   yaml-теги в wire-типах.

Решение: данные живут **только в PostgreSQL**. YAML удаляется полностью —
включая внутренний конвейер. Заодно удаляется CLI: все функции переехали
в веб-интерфейс, headless-развёртывание скриптов не используется
(в перспективе его заменит агент на устройствах, читающий данные из API).
Бинарь превращается из CLI-приложения в сервер: `firenet` без подкоманд
просто запускает веб-приложение.

## Решение

### 1. Конвертеры ProjectDoc → доменная модель (уже начато)

В `internal/projectdoc/convert.go` добавлены конвертеры по образцу
существующего `PolicyDoc.ToPolicy()`:

- `TopologyDoc.ToTopology() (*topology.Topology, error)` — переносит
  логику `topology.Load`: проверка kind устройств, дубликаты имён,
  `parseHostPrefix` для адресов наборов.
- `SubnetsDoc.ToSubnets() (map[string]topology.Subnet, error)` — парсинг
  CIDR, дубликаты имён (пересечение CIDR остаётся в `topology.Validate`).
- `ProjectDoc.ToRules() *rules.Policy` — обёртка `Rules.ToPolicy()`.

Тесты: `internal/projectdoc/convert_test.go` (уже написан, зелёный).

Отличие от старого `rules.Load`: yaml-декодер подставлял дефолты
(`defaultAction: deny`, `chainPosition: top` для первой цепочки,
`DefaultChainName`, `proto: any`). Эти дефолты переносятся в
`PolicyDoc.ToPolicy()`, чтобы поведение validate/compile/diagnose не
изменилось. Дефолт одного действия также применяется в `NewPolicyDoc`
(обратная конвертация) — иначе round-trip через БД терял бы дефолт.

### 2. Слой app — сигнатуры на ProjectDoc

`internal/app/load.go`:

- `LoadProject(doc projectdoc.ProjectDoc) (*topology.Topology, error)` —
  `doc.Topology.ToTopology()` + `doc.Subnets.ToSubnets()` +
  `topo.Validate()` + `graph.ValidateFilterExports(topo)`.
- `ParseProject(doc)` — то же без `Validate` (для diff'ов удалений).

`internal/app/compile.go` / `diagnose.go`:

- `CompileOptions`, `DiagnoseOptions`, `SpreadOptions`: три поля
  `TopologyYAML/SubnetsYAML/RulesYAML []byte` → одно
  `Doc projectdoc.ProjectDoc`.
- Внутри `Compile/Diagnose/Spread`: `LoadProject(opts.Doc)`,
  `pol := opts.Doc.ToRules()`, дальше без изменений.

`internal/app/lint.go` — сигнатура не меняется (принимает уже
загруженные `topo` и `pol`).

### 3. topology и rules — чистые модели

- `internal/topology/load.go` удаляется целиком (yaml-структуры, `Load`,
  `LoadSubnets`, `parseHostPrefix`); `load_test.go` удаляется — его
  покрытие перенесено в `projectdoc/convert_test.go` + существующие
  `validate_test.go`.
- `internal/rules/load.go` удаляется целиком (`Load`, `decodeModern`,
  `decodeLegacy`, `decodeRules`); load_test.go переезжает на
  конструирование `PolicyDoc` + `ToPolicy()` (см. задачу 4).
- yaml-теги снимаются с типов `internal/projectdoc` (JSON — единственный
  wire-формат).
- `internal/rules` теряет зависимость от `gopkg.in/yaml.v3` (legacy
  flat-формат `rules.yaml` больше не читается; из БД всё приходит уже в
  chains-виде).

### 4. httpapi — прямой путь doc → модель

`internal/httpapi/handlers.go`:

- `deletionErrorsFromDocs`: вместо `yaml.Marshal` → `app.LoadProject` —
  прямые `prev.Topology.ToTopology()` и т.д. Merge сабнетов в Topology:
  `topo.Subnets, _ = prev.Subnets.ToSubnets()`.
- `loadTopologyDoc`, `compileDoc`, `diagnoseDoc`, `spreadDoc`:
  yaml.Marshal-прослойки удаляются; `app.Compile(ctx, log,
  app.CompileOptions{Doc: doc})` и т.п.
- `validateDoc`: `loadTopologyDoc` остаётся, но уже без YAML.
- Тест-фикстуры: YAML-строки в `handlers_test.go` и `writeDraftRules`
  переводятся на конструирование `projectdoc`-структур напрямую.

### 5. CLI удаляется; бинарь = сервер

Все функции CLI уже покрыты веб-интерфейсом (валидация и компиляция —
страницы UI; скачивание скриптов — через браузер). Headless-развёртывание
не используется; в перспективе его заменит агент на устройствах, читающий
правила и ipset из API. Поэтому вместо перевода CLI на чтение из БД
(изначальный замысел) пакет удаляется целиком:

- `internal/cli/` — удаляется весь пакет (`root.go`, `serve.go`,
  `validate.go`, `compile.go`, `version.go`, `legacy.go`, `legacy_test.go`);
  `github.com/spf13/cobra` уходит из `go.mod`.
- `cmd/firenet/main.go` сам делает то, что делал `serve` без legacy-части:
  `config.Load()` → `logger.New` → `db.Open` → `db.Migrate` →
  `BootstrapAdmin` → `SeedInitialVersion(ctx, projectdoc.ProjectDoc{},
  actor)` → `httpapi.NewServer` → `http.ListenAndServe`.
- `internal/httpapi/store.go` (`FileProjectStore`) — удаляется.
- `app.Version()` из `cli/version.go` больше не вызывается — проверяется
  использование и удаляется, если клиентов нет (тест `version_test.go`
  при наличии).
- Адрес слушателя: флаг `--addr` заменяется на переменную
  `FIRENET_ADDR` в `config.Config` (дефолт `127.0.0.1:8787`);
  Dockerfile ENTRYPOINT меняется на `["/firenet"]` с
  `FIRENET_ADDR=0.0.0.0:8787` в ENV (или адрес задаётся в
  docker-compose.yml).
- Флаг `--open` (открыть браузер на старте) не переносится.

### 6. Файлы, документация, зависимости

- Удаляются: `topology.yaml`, `subnets.yaml`, `rules.yaml` (корень),
  `examples/`.
- `e2e/global-setup.js`: подкоманда `serve` и флаги
  `--topology/--subnets/--rules`, `--addr` и `./.tmp/`-махинации
  убираются — `bin/firenet` стартует с `FIRENET_ADDR` и
  `FIRENET_DATABASE_URL` (пустая БД → пустая версия 1, e2e-сценарии
  создают данные сами через UI/API).
- `Dockerfile`: `ENTRYPOINT ["/firenet"]`; `serve --addr` больше не
  существует.
- `README.md`: раздел про импорт YAML при первом запуске заменяется на
  «данные хранятся в PostgreSQL; при первом запуске создаётся пустой
  проект»; из описания структуры проекта уходит `internal/cli`.
- `go.mod`: `go mod tidy` убирает `gopkg.in/yaml.v3` и
  `github.com/spf13/cobra`.
- `.gitignore`, Makefile — без изменений (сборка `./cmd/firenet`
  сохраняется).

## Риски / совместимость

- Breaking change строже исходного замысла: исчезают команды
  `validate`, `compile`, `serve`, `version`, а также флаги
  `--out/--stdout/--device/--max-hops/--max-paths` у compile. Кто
  держал cron/скрипты на `compile --out`, теряет эту возможность;
  headless-компиляция не используется (владелец проекта подтвердил),
  в перспективе её заменит агент на устройствах. Первичный импорт
  YAML исчезает — у кого данные только в YAML, теряют их; по
  договорённости с владельцем проекта это принято.
- Адрес сервера теперь задаётся только переменной `FIRENET_ADDR` —
  флага `--addr` больше нет (docker-compose/e2e обновляются).
- Дефолты правил переносятся в `ToPolicy` — покрывается тестами на
  равенство с прежним `rules.Load` (задача 4).
- e2e стартует с пустым проектом; сценарии уже создают данные сами
  (проверить, что ни один сценарий не зависит от seed-данных YAML —
  глобальный сетап их и не создавал: файлы не существовали).

## Тестирование

- Юнит: конвертеры (готово), перенесённые rules-тесты, обновлённые
  app/httpapi-тесты.
- Регресс: `go build ./...`, `go vet ./...`, `gofmt -l .`, `go test ./...`,
  `node --test internal/httpapi/web/*.test.js`, `make test-e2e`.
- Вручную: запуск `bin/firenet` против живого Postgres — сервер
  поднимается, UI работает.
