import { test, describe } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { makeTestApp } from "./harness.ts";

describe("P5 SKILL.md extraction", () => {
  test("completing a project extracts a draft skill from applied guides + blockers + antipatterns", async () => {
    const ctx = await makeTestApp();
    const app = ctx.app;
    const owner = request.agent(app);
    await owner.post("/api/auth/bootstrap").send({ email: "o@x.com", password: "password123", full_name: "Owner" });
    const proj = await owner.post("/api/projects").send({ name: "Delta" });
    const pid = proj.body.project.id;
    const inv = await owner.post(`/api/projects/${pid}/invites`).send({ email: "m@x.com", role: "member" });
    const member = request.agent(app);
    const acc = await member.post("/api/auth/accept-invite").send({ token: inv.body.token, password: "memberpass1", full_name: "Mem" });
    const memberId = acc.body.user.id;

    // task with a guide the member applies
    const t1 = await owner.post(`/api/projects/${pid}/tasks`).send({ title: "Set up CI", assignee_ids: [memberId] });
    const g1 = await owner.post("/api/comments").send({ task_id: t1.body.task.id, body: "캐시 키에 lockfile 해시를 넣어라", is_guide: true });
    await member.patch(`/api/comments/${g1.body.comment.id}/guide`).send({ state: "applied", note: "빌드 40% 단축" });

    // task blocked then resolved (hard-won lesson)
    const t2 = await owner.post(`/api/projects/${pid}/tasks`).send({ title: "Fix flaky test", assignee_ids: [memberId] });
    await owner.patch(`/api/tasks/${t2.body.task.id}`).send({ status: "blocked" });
    await owner.patch(`/api/tasks/${t2.body.task.id}`).send({ status: "done" });

    // task with a skipped guide (antipattern)
    const t3 = await owner.post(`/api/projects/${pid}/tasks`).send({ title: "Optimize", assignee_ids: [memberId] });
    const g3 = await owner.post("/api/comments").send({ task_id: t3.body.task.id, body: "전역 뮤텍스로 감싸라", is_guide: true });
    await member.patch(`/api/comments/${g3.body.comment.id}/guide`).send({ state: "skipped", note: "성능 저하로 사용 안 함" });
    await owner.patch(`/api/tasks/${t1.body.task.id}`).send({ status: "done" });

    // complete the project -> triggers extraction
    const done = await owner.patch(`/api/projects/${pid}`).send({ status: "completed" });
    assert.equal(done.status, 200);

    // draft skill exists (never auto-published)
    const list = await owner.get(`/api/skills?project_id=${pid}`);
    assert.equal(list.status, 200);
    assert.ok(list.body.skills.length >= 1, "at least one draft skill");
    const skill = list.body.skills[0];
    assert.equal(skill.status, "draft", "extraction produces draft, human publishes (§13)");
    assert.match(skill.body, /lockfile/, "applied guide captured in body");
    assert.match(skill.body, /Fix flaky test/, "resolved blocker captured");
    assert.match(skill.antipatterns, /뮤텍스/, "skipped guide captured as antipattern");
    assert.ok(skill.source_refs.length >= 1, "source_refs back-reference");

    // publish it -> appears org-wide
    const pub = await owner.patch(`/api/skills/${skill.id}`).send({ status: "published" });
    assert.equal(pub.body.skill.status, "published");

    // export SKILL.md
    const exp = await owner.get(`/api/skills/${skill.id}/export`);
    assert.equal(exp.status, 200);
    assert.match(exp.headers["content-type"], /markdown/);
    assert.match(exp.text, /^---\nname:/);
    assert.match(exp.text, /Antipatterns/);

    // member (non-manager) cannot manually trigger extraction
    const denied = await member.post(`/api/skills/extract/${pid}`);
    assert.equal(denied.status, 403);
  });
});
