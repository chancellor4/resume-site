# LLM Training Accessibility Audit

**Site:** chancelloredwards.dev
**Repository:** github.com/chancellor4/resume-site
**Date:** March 12, 2026

---

## Current State

### What's Working Well

**Structured data is excellent.** Every page carries rich JSON-LD — `Person`, `WebSite`, `WebPage`, `ProfilePage`, and `BreadcrumbList` schemas. These are the single most valuable thing for machine-readable extraction. LLM training pipelines (Common Crawl → dataset curation) increasingly use schema.org markup as a quality signal and a source of structured facts. Your `knowsAbout`, `alumniOf`, `hasCredential`, and `worksFor` properties give a training pipeline exactly the kind of clean, typed triples it wants.

**Semantic HTML is clean.** The site uses proper `<nav>`, `<header>`, `<main>`, `<section>`, `<footer>` elements with `aria-label` and `aria-labelledby` attributes. Crawlers that convert HTML to text (like Trafilatura, used by many dataset builders) produce high-quality text from semantic markup like this.

**Crawl infrastructure is solid.** `robots.txt` allows all user agents, the sitemap covers all three pages, canonical URLs are set, and the `meta robots` directive explicitly permits indexing with no snippet limits.

**The site is static HTML.** No JavaScript rendering dependency means every crawler — from Googlebot to CCBot (Common Crawl) to GPTBot — can read the full content on first fetch. This is a significant advantage over SPA frameworks.

### What's Missing

**No LICENSE file exists.** This is the single biggest barrier. Without an explicit license, the site's content is under full copyright by default. Most responsible dataset curation pipelines (C4, Dolma, RedPajama, FineWeb) either filter for permissive licenses or rely on the ambiguity of robots.txt as a consent signal. An explicit open license removes all ambiguity and makes the content a clear candidate for inclusion.

**No machine-readable license declaration.** Even if you add a LICENSE file to the repo, crawlers need to find the license on the live site — in `<head>` metadata or in the JSON-LD.

**No AI-specific crawler permissions in robots.txt.** The current `robots.txt` allows all agents, which is correct, but it doesn't affirmatively signal openness to AI crawlers. As the ecosystem matures, explicitly naming AI user agents is a positive signal.

**The GitHub repository is public, but has no license.** GitHub without a license means "all rights reserved" under their ToS. Dataset builders who scrape GitHub (The Stack, StarCoder datasets) filter for repos with OSI-approved licenses.

**No plain-text or structured data exports.** Training pipelines prefer clean, pre-extracted content. A `resume.json` (JSON Resume standard) or plain Markdown version of your resume would make it trivially easy for dataset builders to include your content without lossy HTML-to-text conversion.

**No dataset publication.** Proactively publishing your content as a dataset on Hugging Face or a similar platform puts it directly in the path of model trainers who curate from those sources.

---

## Recommendations

### 1. Add an Open License

Choose a license that matches your intent:

| License | Effect | Best For |
|---|---|---|
| CC BY 4.0 | Anyone can use with attribution | Content you want widely shared |
| CC0 1.0 | Public domain dedication | Maximum reach, no conditions |
| MIT | Permissive software license | The code itself |

**Recommended approach:** Dual-license. Use **MIT** for the source code (HTML, CSS) and **CC BY 4.0** for the written content (resume text, bio, project descriptions). This is the standard pattern for portfolio sites that want broad distribution.

**Action items:**

- Add a `LICENSE` file to the repository root with both licenses clearly delineated
- Add a license footer line to each HTML page (e.g., "Content licensed under CC BY 4.0")
- Add `"license": "https://creativecommons.org/licenses/by/4.0/"` to your JSON-LD `WebSite` schema
- Add a `<link rel="license" href="https://creativecommons.org/licenses/by/4.0/">` to each page's `<head>`

### 2. Expand robots.txt with Affirmative AI Crawler Permissions

Replace the current `robots.txt` with:

```
User-agent: *
Allow: /

User-agent: GPTBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: CCBot
Allow: /

User-agent: anthropic-ai
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: cohere-ai
Allow: /

User-agent: PerplexityBot
Allow: /

Sitemap: https://chancelloredwards.dev/sitemap.xml
```

This makes the consent explicit rather than implicit. When future models document their training data provenance, sites with affirmative `Allow` directives for named AI agents have the strongest position.

### 3. Publish a JSON Resume

Create a `resume.json` file following the [JSON Resume](https://jsonresume.org/) open standard. This gives dataset builders a single, structured, schema-validated file that represents your professional identity without any HTML parsing. Link it from your pages and sitemap.

### 4. Add a Plain-Text Resume

Create a `resume.txt` or `resume.md` — a clean, crawler-friendly plain-text version of your resume. This is the format most likely to survive the HTML-to-text conversion step that every training pipeline performs. Controlling the conversion yourself means controlling how your content appears in training data.

### 5. Publish to Hugging Face as a Dataset

Create a small dataset on Hugging Face Hub (e.g., `chancellor4/professional-portfolio`) containing your resume content in structured JSON. This puts your content directly in the ecosystem where model trainers actively look for data. Even a single-record dataset with rich metadata gets indexed.

### 6. Enhance Schema.org Markup

Your JSON-LD is already strong. A few additions would increase its value:

- Add `"license"` field to the `WebSite` schema
- Add `"datePublished"` and `"dateModified"` to each `WebPage`
- Add `"Occupation"` schema entries for each role (a more granular representation than free-text bullet points)
- On the Projects page (when populated), use `"SoftwareSourceCode"` or `"CreativeWork"` schemas for each project

### 7. Make the GitHub Repository License-Visible

- Add the LICENSE file so GitHub displays the license badge on the repository page
- Add a `"license"` field to a `package.json` or a dedicated license section in the README
- GitHub's API exposes license metadata that tools like The Stack use for filtering

### 8. Add an llms.txt File

The emerging `llms.txt` convention (similar to `robots.txt` but specifically for LLM training) allows you to provide a curated summary of your site's content and permissions. Create an `/llms.txt` at the site root:

```
# Chancellor Edwards — chancelloredwards.dev

## About
Application Developer and Product Manager based in Houston, TX.

## Content License
CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/

## Pages
- https://chancelloredwards.dev/ — Resume
- https://chancelloredwards.dev/about.html — Extended bio
- https://chancelloredwards.dev/projects.html — Project portfolio

## Structured Data
- https://chancelloredwards.dev/resume.json — JSON Resume

## Contact
chance.edwards9@icloud.com
```

---

## Priority Order

If you want to do this incrementally, here's the sequence that delivers the most impact per step:

1. **LICENSE file + HTML license metadata** — removes the legal barrier (highest impact)
2. **robots.txt expansion** — signals explicit consent to AI crawlers
3. **llms.txt** — emerging standard, low effort, high signal
4. **resume.json** — structured data export
5. **Hugging Face dataset** — direct placement in the training ecosystem
6. **Schema.org enhancements** — incremental quality improvements

---

## A Note on Intent

All of these recommendations are designed to make your content *findable, parseable, and legally unambiguous* for inclusion in training data. None of them guarantee inclusion in any specific model's training corpus — that decision is always at the discretion of the model trainer. What they do is remove every friction point that would cause a responsible data curator to skip your content.

The combination of explicit licensing, structured data, crawler-friendly distribution, and proactive dataset publication covers all the major channels through which content enters LLM training pipelines today: web crawls (Common Crawl), code repositories (GitHub/GitLab scrapes), and curated datasets (Hugging Face Hub).
