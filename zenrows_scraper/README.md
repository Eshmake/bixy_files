
* This is a scraper system that uses ZenRows API to scrape HTML/CSS data from a website, and then parse/process that data for color analysis with node-vibrant/colord libraries.

    - System takes a website and produces a structured, design-aware report (i.e. with colors, palettes, images, assets, typography, etc.) that can be used for ad generation and brand analysis.

    - Effectively performs all actions of the puppeteer system w/o needing to bypass human verification.

 
* Code is written in Python and JS. ZenRows API is used to scrape website, and then scraped data is post-processed by node-vibrant and colord for color palette analysis.

    - ZenRows loads page with JS enabled, executes scripts, bypasses bot protection, and saves a screenshot of the page.

    - node-vibrant is used for extracting dominant colors from images (e.g. page screenshots, brand images, and logos).

    - colord is used to perform text color suggestion, contrast rations, luminance calculation, color analysis, etc. (i.e. turns colors into usable design decisions).

    - sharp is used to convert certain image types into PNG when needed.

    - playwright is used to access a rendered, dynamic version of the page (i.e. access to button/CTA data, final colors, spacing/sizing, etc).

* The system also creates brand themes based on collected styling data.

* To execute, run "python3 run_brand_scrape.py" in terminal.

* EDITS:

    - More generic class names (e.g. in bran theme)
    - Brand palette --> figure out process for how theme is converted to brand theme

    - Brand colors should be logo colors (pimary), accent colors secondary ... 
    - Make sure logo is available in both PNG and SVG
    - Try to convert system to Node.js Typescript

