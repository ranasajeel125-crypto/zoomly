// End-to-end tests for Zoomly stories (Phase 3E): 24h stories on the story
// strip (own + followees only; strip lives in the Watch tab's Stories
// section since 2026-10-23), view recording, the owner's viewers list,
// profile story payload, deletion, and expiry (a 25h-old story is not
// shown and is cleaned up on read). Needs direct DB access (TEST_DB_URL)
// to plant the expired story.
//
//   PORT=3109 ADMIN_USERNAME=sajeel TURSO_DATABASE_URL=file:/tmp/zoomly-stories.db npm start
//   BASE_URL=http://localhost:3109 TEST_DB_URL=file:/tmp/zoomly-stories.db node scripts/stories-test.mjs
import { createClient } from "@libsql/client";

const BASE = process.env.BASE_URL || "http://localhost:3109";
const DB_URL = process.env.TEST_DB_URL || "file:/tmp/zoomly-stories.db";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name} ${extra}`);
  }
}
async function api(action, args = {}) {
  const res = await fetch(`${BASE}/api/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  return res.json();
}
const db = createClient({ url: DB_URL });

console.log(`Stories test against ${BASE}`);
const suffix = Math.random().toString(36).slice(2, 8);
const mkUser = async (name) => {
  const res = await api("signup", { username: `${name}_${suffix}`, display_name: `User ${name}`, password: "test-pass-123" });
  if (!res.ok) throw new Error(`signup ${name} failed`);
  return { token: res.token, user: res.user };
};
const A = await mkUser("sta");
const B = await mkUser("stb");
const C = await mkUser("stc");

// A posts a story.
const made = await api("createStory", { token: A.token, media_url: "https://example.com/story1.jpg", media_type: "image" });
check("story created", made.ok === true && Boolean(made.story?.id), JSON.stringify(made));
const storyId = made.story.id;

// Not visible to a non-follower.
let bStories = await api("getStories", { token: B.token });
check("non-follower sees no group for A", !bStories.groups?.some((g) => g.author?.id === A.user.id), JSON.stringify(bStories.groups));
// Nor can a non-follower record a view.
const blockedView = await api("viewStory", { token: C.token, story_id: storyId });
check("non-follower cannot view the story", blockedView.ok === false, JSON.stringify(blockedView));

// B follows A -> the group appears, unseen.
await api("toggleFollow", { token: B.token, user_id: A.user.id });
bStories = await api("getStories", { token: B.token });
const groupB = bStories.groups?.find((g) => g.author?.id === A.user.id);
check("follower sees A's story group", Boolean(groupB) && groupB.stories.length === 1, JSON.stringify(bStories.groups).slice(0, 200));
check("group starts unseen", groupB?.has_unseen === true && groupB.stories[0].seen_by_me === false);

// B views it -> view recorded once, group becomes seen.
const view1 = await api("viewStory", { token: B.token, story_id: storyId });
check("view recorded (count 1)", view1.ok === true && view1.view_count === 1, JSON.stringify(view1));
const view2 = await api("viewStory", { token: B.token, story_id: storyId });
check("re-view does not double count", view2.ok === true && view2.view_count === 1, JSON.stringify(view2));
bStories = await api("getStories", { token: B.token });
check("group is seen after viewing", bStories.groups?.find((g) => g.author?.id === A.user.id)?.has_unseen === false);

// The owner's own view is not counted; the viewers list shows B.
const ownView = await api("viewStory", { token: A.token, story_id: storyId });
check("owner view not counted", ownView.ok === true && ownView.view_count === 1, JSON.stringify(ownView));
const viewers = await api("getStoryViewers", { token: A.token, story_id: storyId });
check("owner sees the viewers list (B)", viewers.ok === true && viewers.viewers?.length === 1 && viewers.viewers[0].viewer.username === B.user.username, JSON.stringify(viewers));
const viewersByB = await api("getStoryViewers", { token: B.token, story_id: storyId });
check("non-owner cannot read the viewers list", viewersByB.ok === false);

// Profile carries the story ring payload for followers (and hides it from others).
const profileForB = await api("getProfile", { token: B.token, user_id: A.user.id });
check("profile includes active stories for a follower", Array.isArray(profileForB.stories) && profileForB.stories.length === 1, JSON.stringify(profileForB.stories));
const profileForC = await api("getProfile", { token: C.token, user_id: A.user.id });
check("profile hides stories from a non-follower", Array.isArray(profileForC.stories) && profileForC.stories.length === 0);

// Expiry: plant a 25h-old story directly in the DB -> never shown, and a
// getStories read cleans it up.
const oldTs = Date.now() - 25 * 60 * 60 * 1000;
await db.execute({
  sql: "INSERT INTO stories (user_id, media_url, media_public_id, media_type, created_at) VALUES (?, ?, NULL, 'image', ?)",
  args: [A.user.id, "https://example.com/old.jpg", oldTs],
});
const aStories = await api("getStories", { token: A.token });
const aGroup = aStories.groups?.find((g) => g.author?.id === A.user.id);
check("25h-old story is not shown", Boolean(aGroup) && aGroup.stories.length === 1 && aGroup.stories[0].id === storyId, JSON.stringify(aGroup).slice(0, 200));
const oldRows = await db.execute({ sql: "SELECT id FROM stories WHERE media_url = ?", args: ["https://example.com/old.jpg"] });
check("expired story cleaned up on read", oldRows.rows.length === 0);
const viewOld = await api("viewStory", { token: B.token, story_id: storyId + 1000 });
check("viewing a missing story fails cleanly", viewOld.ok === false);

// Deletion: only the owner.
const delByB = await api("deleteStory", { token: B.token, story_id: storyId });
check("non-owner cannot delete the story", delByB.ok === false);
const delByA = await api("deleteStory", { token: A.token, story_id: storyId });
check("owner deletes the story", delByA.ok === true, JSON.stringify(delByA));
bStories = await api("getStories", { token: B.token });
check("deleted story group disappears", !bStories.groups?.some((g) => g.author?.id === A.user.id));

console.log(failures === 0 ? "\nSTORIES TEST PASSED ✔" : `\nSTORIES TEST FAILED — ${failures} check(s) failed ✗`);
process.exit(failures === 0 ? 0 : 1);
