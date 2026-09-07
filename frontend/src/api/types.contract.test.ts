import { describe, expect, it } from "vitest";
import * as fx from "./fixtures";

// Что этот тест ловит:
//  1. Опечатки и лишние/пропущенные ключи в фикстурах: expectKeys сверяет
//     состав ключей фикстуры с ожидаемым списком, а типы в fixtures.ts —
//     со структурой типов из types.ts. Ошибся в имени поля (например
//     IPSetsScript → IPSetScript) — тест красный.
//  2. Расхождение фикстур с TS-типами: каждая фикстура типизирована
//     аннотацией, так что types.ts и fixtures.ts не разъедутся.
//  3. Обязательные поля: если Go-поле обязательно, фикстура без него не
//     скомпилируется (аннотация типа).
//
// Чего этот тест НЕ ловит: дрейф самих TS-типов относительно Go. Списки
// ключей — литералы из этого же файла, так что переименование поля в Go не
// сделает тест красным само по себе: его заметят только глазами или по
// падению Go-тестов. Настоящая сверка json-тегов Go с ключами TS-типов
// возможна (прочитать internal/projectdoc/*.go через node:fs и вытащить теги
// регуляркой), но связывает фронтенд-тесты с путями и текстом Go-исходников:
// любой рефакторинг на той стороне (переименование файла, смена тега на
// кастомный MarshalJSON) ломает фронтенд-тесты, не имея к ним отношения.
// Договорились не делать; см. раздел «Fix round 1» в task-2-report.md.

function expectKeys<T>(value: T, keys: string[]) {
  expect(Object.keys(value as object).sort()).toEqual([...keys].sort());
}

describe("API contract", () => {
  it("TopologyDoc matches Go json tags", () => {
    const t = fx.topologyFixture;
    expectKeys(t, ["devices", "links", "networks", "sets", "unions"]);
    expectKeys(t.devices![0], ["name", "kind"]);
    expectKeys(t.links![0], ["a", "b"]);
    expectKeys(t.networks![0], ["name", "subnets", "attach"]);
    expectKeys(t.sets![0], ["name", "addresses"]);
    expectKeys(t.unions![0], ["name", "devices"]);
  });

  it("SubnetsDoc matches Go json tags", () => {
    const s = fx.subnetsFixture;
    expectKeys(s, ["subnets"]);
    expectKeys(s.subnets![0], ["name", "cidr"]);
  });

  it("PolicyDoc matches Go json tags", () => {
    const p = fx.policyFixture;
    expectKeys(p, ["chains"]);
    expectKeys(p.chains![0], ["name", "defaultAction", "chainPosition", "rules"]);
    expectKeys(p.chains![0].rules[0], ["name", "src", "dst", "proto", "dstPorts", "action"]);
  });

  it("LayoutDoc matches Go json tags", () => {
    const l = fx.layoutFixture;
    expectKeys(l, ["devices", "networks", "links", "camera"]);
    expectKeys(l.camera!, ["x", "y", "z"]);
    expectKeys(l.devices!.r1, ["x", "y"]);
  });

  it("EditorSnapshot matches Go json tags", () => {
    expectKeys(fx.editorSnapshotFixture, ["topology", "layout"]);
  });

  it("DraftResponse and UserResponse match Go json tags", () => {
    expectKeys(fx.draftFixture, ["id", "owner", "name", "baseVersion", "status"]);
    expectKeys(fx.userFixture, ["id", "username", "role", "activated", "createdAt"]);
  });

  it("VersionInfo matches Go json tags", () => {
    expectKeys(fx.versionInfoFixture, ["id", "createdAt", "confirmedBy", "draftId", "note"]);
  });

  // Поля без json-тегов — приходят именами Go, опечатка тут всего вероятнее.
  it("CompiledDevice uses Go field names", () => {
    expectKeys(fx.compileFixture[0], ["Name", "IPSetsScript", "RulesScript"]);
  });

  it("SearchEntry and LintFinding match Go json tags", () => {
    expectKeys(fx.searchIndexFixture[0], ["type", "name", "details"]);
    expectKeys(fx.searchIndexFixture[1], ["type", "name", "details", "prefixes"]);
    expectKeys(fx.lintFixture[0], ["severity", "chain", "rules", "message"]);
  });

  it("diff types match Go json tags", () => {
    expectKeys(fx.entityDiffFixture, ["kind", "key", "change", "before", "after"]);
    expectKeys(fx.draftDiffEntryFixture, ["kind", "key", "change", "before", "after", "conflict"]);
    expectKeys(fx.conflictFixture, ["kind", "key", "draftValue", "currentValue"]);
  });

  it("diagnose types match Go json tags", () => {
    expectKeys(fx.diagnoseReportFixture, [
      "srcSubnet", "dstSubnet", "note", "paths", "returnPathAllowed", "mapMark",
    ]);
    expectKeys(fx.mapMarkFixture, ["hl", "ok", "okE", "denyE", "half", "halfE", "deny"]);
    expectKeys(fx.mapMarkFixture.deny.r2, ["rule", "reason"]);
    expectKeys(fx.denyInfoFixture, ["rule", "reason"]);
    expectKeys(fx.pathResultFixture, ["nodes", "routers", "verdict", "note"]);
    expectKeys(fx.routerVerdictFixture, ["router", "action", "matchedRule", "reason", "steps"]);
    expectKeys(fx.graphNodeFixture, ["kind", "name"]);
  });

  it("spread types match Go json tags", () => {
    expectKeys(fx.spreadResultFixture, ["sources", "reports", "mark"]);
    expectKeys(fx.spreadResultFixture.sources[0], ["IP", "SubnetName"]);
    expectKeys(fx.spreadResultFixture.reports[0], ["candidate", "report"]);
    expectKeys(fx.diagnoseRequestFixture, ["src", "dst", "proto", "srcPorts", "dstPorts"]);
    expectKeys(fx.spreadRequestFixture, ["src", "proto", "dstPorts"]);
  });

  it("topology operation payload matches Go json tags", () => {
    expectKeys(fx.topologyOperationFixture, ["kind", "deviceName", "position"]);
  });

  it("response envelopes match Go json tags", () => {
    expectKeys(fx.linkExportsFixture, ["entities"]);
    expectKeys(fx.linkExportsFixture.entities[0], ["name", "cidr"]);
    expectKeys(fx.lintResponseFixture, ["findings"]);
    expectKeys(fx.validateResponseFixture, ["valid", "errors"]);
    expectKeys(fx.restoreResponseFixture, ["version"]);
    expectKeys(fx.confirmResponseFixture, ["version"]);
    expectKeys(fx.confirmConflictResponseFixture, ["conflicts"]);
    expectKeys(fx.createUserResponseFixture, ["user", "inviteUrl"]);
    expectKeys(fx.inviteInfoResponseFixture, ["username"]);
    expectKeys(fx.inviteURLResponseFixture, ["inviteUrl"]);
    expectKeys(fx.errorResponseFixture, ["error"]);
  });

  it("nullable slices are representable as null", () => {
    expect(fx.validateResponseFixture.errors).toBeNull();
    expect(fx.lintResponseFixture.findings).not.toBeNull();
  });
});
