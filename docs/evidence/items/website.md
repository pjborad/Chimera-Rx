# Website round: project site on GitHub Pages

- `docs/index.html`, `docs/site.css`, `docs/site.js` replace the text page. Static, no build step, no external fonts, scripts or trackers, relative asset URLs, `docs/.nojekyll`. The `#demo-video` anchor, video, poster and captions are unchanged.
- Sections: hero, demo video, the gap, flow, roles, AI agents, integrations and placeholder map, security, Built with Kiro, screens, try it, footer notice.
- Screenshots in `docs/img` were retaken from the current build (the old ones showed removed Demo scenarios and Test labels): sign-in, today, agents, plus new recall-lookup and recall-impact.
- Checked at 1440 and 390 px (full page): no horizontal overflow, no failed requests or console errors. Captures: `docs/evidence/screens/site-1440.png`, `site-390.png`.
- All 15 GitHub file links exist on origin/main; the three external source links return 200 or 203.
- Not checked: the live Pages deploy (lead pushes), screen-reader pass, contrast measured by tool.
