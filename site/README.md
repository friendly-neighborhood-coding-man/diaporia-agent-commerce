# DIAPORIA Buy landing page

Standalone, dependency-free static site for the open-source DIAPORIA Buy purchasing engine.

This is **not** the private DIAPORIA general-agent product. The site borrows its editorial layout, colors, DIAPORIA mark and light/dark behavior from the existing [DIAPORIA site](https://friendly-neighborhood-coding-man.github.io/diaporia/), while documenting only public Buy capabilities.

## Preview locally

```bash
python3 -m http.server 8000 --directory site
# http://localhost:8000/
```

Validate with `node site/check-site.mjs`. No Node dependencies or build tool are required.

## Publish

On merge to `main`, `.github/workflows/pages.yml` uploads only the `site/` directory to GitHub Pages. In repository Settings → Pages, set **Build and deployment: GitHub Actions** if not already enabled.

Expected public URL after deployment (not live until Pages is enabled and the workflow succeeds):

https://friendly-neighborhood-coding-man.github.io/diaporia-agent-commerce/

The recorded YouTube demo is embedded from https://youtu.be/8ILykmc_WNw. It uses fictional products and MOCK payments. The PayPal Sandbox status and lack of production merchant fulfillment are disclosed on the landing page.

## Maintenance

- Source-code changes are **not** inferred to update the marketing claims automatically. Keep proof points aligned to tagged/verified commits.
- This site contains no credentials, live API calls, trackers, third-party logos or external font downloads.
- Do not publish proprietary APORIA / DIAPORIA research details or private training data here.
