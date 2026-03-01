# Deployment & Launch Checklist

Everything below requires your action — these steps can't be automated here.
Work through them in order; each phase depends on the previous one being complete.

---

## Phase 2 — Deploy to GitHub Pages

### Decision point
GitHub Pages requires a **public** repo on the free plan.
If you need a private repo, upgrade to GitHub Pro ($4/mo) or use Netlify instead.

### Steps

```bash
# 1. Initialize git in your local site folder (if not already a repo)
cd path/to/Resume\ website
git init
git add .
git commit -m "Initial commit: resume site"

# 2. Create a new repo on GitHub (name it: resume-site or your-name-site)
#    → github.com/new

# 3. Push
git remote add origin https://github.com/YOUR_USERNAME/resume-site.git
git branch -M main
git push -u origin main
```

Then in GitHub:
1. Go to your repo → **Settings** → **Pages**
2. Source: **Deploy from a branch**
3. Branch: `main` / folder: `/ (root)`
4. Click **Save**
5. Wait ~60 seconds → site is live at `https://YOUR_USERNAME.github.io/resume-site`

### Verification
- [ ] Site loads at `https://YOUR_USERNAME.github.io/resume-site`
- [ ] Browser shows padlock (HTTPS active)
- [ ] Both pages load: `/` and `/projects.html`
- [ ] Nav links work between pages

---

## Phase 3 — Custom Domain

### Decision point
**Recommended registrar:** Cloudflare Registrar (at-cost pricing, free DNS management)
**Alternative:** Namecheap (slightly cheaper `.com` renewal sometimes)

Suggested domain: `chanceeedwards.com` or `chance.dev`

### Steps

1. **Buy the domain** at [cloudflare.com/products/registrar](https://www.cloudflare.com/products/registrar/) or [namecheap.com](https://www.namecheap.com)

2. **Add CNAME file** to your repo root:
   ```
   # Create a file named exactly: CNAME (no extension)
   # Contents (one line, your domain):
   chanceeedwards.com
   ```
   Commit and push.

3. **Set DNS records** (in Cloudflare or your registrar's DNS panel):

   | Type | Name | Value |
   |------|------|-------|
   | A | @ | 185.199.108.153 |
   | A | @ | 185.199.109.153 |
   | A | @ | 185.199.110.153 |
   | A | @ | 185.199.111.153 |
   | CNAME | www | YOUR_USERNAME.github.io |

4. **In GitHub Pages settings:** Enter your custom domain → Save
   GitHub will auto-provision HTTPS via Let's Encrypt (takes ~24 hrs for DNS to propagate)

5. **Update these files** once domain is live:
   - `index.html` → canonical URL and og:url
   - `projects.html` → canonical URL and og:url
   - `sitemap.xml` → both `<loc>` URLs
   - `robots.txt` → Sitemap URL

### Verification
- [ ] Site resolves at `https://chanceeedwards.com`
- [ ] HTTPS padlock shows your domain (not github.io)
- [ ] www redirect works (www → apex)

---

## Phase 3 — Google Search Console

### Steps

1. Go to [search.google.com/search-console](https://search.google.com/search-console)
2. Click **Add Property** → **URL prefix** → enter your full domain
3. **Verify ownership** using the HTML file method:
   - Download the verification file Google provides
   - Add it to your repo root
   - Commit and push
   - Click Verify in Search Console
4. Once verified → **Sitemaps** → enter `sitemap.xml` → Submit

### Verification
- [ ] Property verified in Search Console
- [ ] Sitemap submitted with status "Success"
- [ ] Within 1–2 weeks: `site:chanceeedwards.com` in Google returns your pages

---

## Phase 4 — Ongoing Maintenance

| Trigger | Action |
|---------|--------|
| New job / role | Update `index.html` experience section, commit & push |
| New project | Add card to `projects.html`, commit & push |
| Site has >5 pages | Evaluate Eleventy (11ty) for templating |
| `site:yourdomain.com` returns no results after 3 weeks | Re-check sitemap submission and robots.txt |

---

*Generated March 2026 · Chancellor Edwards Resume Site*
