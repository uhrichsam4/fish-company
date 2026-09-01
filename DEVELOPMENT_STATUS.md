# Fish Company — Development Status

Live status board. Legend: ✅ done · 🟡 partial · 🔴 broken · ⬜ unstarted · 🧪 needs testing · 💅 needs polish

## Build
- Vite dev server: `npm run dev` → http://localhost:5178
- Test server (no HMR): `npx vite --config vite.test.config.js` → http://localhost:5180
- Automated scenarios: in console `const S = await import('/tools/scenarios.js'); await S.run()`
