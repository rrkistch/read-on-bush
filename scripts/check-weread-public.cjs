// Public preview smoke test. No user credentials, no progress writes, no book text in output.
// Run after npm run compile: node scripts/check-weread-public.cjs [bookId] [chapterUid]
const { requestWeRead } = require('../out/infrastructure/weread/Transport');
const { WeReadApi } = require('../out/infrastructure/weread/WeReadApi');
const { weReadMessage } = require('../out/infrastructure/weread/WeReadError');

(async () => {
  const bookId = process.argv[2] || '43208843';
  const uid = Number(process.argv[3] || 1);
  if (!Number.isSafeInteger(uid) || uid < 0) { throw new Error('Invalid chapterUid'); }
  // An anonymous adapter exercises the same API implementation on public previews.
  // It never reads the user's SecretStorage or sends a Cookie header.
  const api = new WeReadApi({ request: requestWeRead });
  const context = await api.context(bookId);
  const chapter = await api.chapter(bookId, uid, context);
  console.log(JSON.stringify({
    publicReaderSession: true, chapterDecoded: true, format: chapter.format,
    textCharacters: chapter.text.length
  }));
})().catch((error) => {
  console.error(weReadMessage(error));
  process.exitCode = 1;
});
