# YouTube Thumbnail Filters — Decisions

A separate Manifest V3 Chrome extension based on `/Users/ivancampos/Code/chrome-ext`. It retains the existing filtering features and replaces TypeSafe with the [OpenAI Decisions API](https://developers.openai.com/api/docs/guides/decisions).

## Install

```sh
npm ci
npm test
npm run build
```

In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select:

`/Users/ivancampos/Code/chrome-ext-dec/dist/youtube-decisions-thumbnail-filters`

Refresh open YouTube tabs. This extension has its own settings and icon; pause the original extension if both are installed so they do not apply competing filters.

## Hide wide-open-mouth thumbnails

1. Open the extension popup and select **Classifiers**.
2. Expand **OpenAI Decisions connection**, paste your OpenAI API key, and save. Use **Test saved key** to check Decisions access with a neutral title. This test is a paid API request.
3. Enable **Classify with OpenAI Decisions** and check **Wide-open mouth** under **Thumbnail images**.
4. Select **Hide entire video** under **On a match**, then **Save all settings**. Uncheck the title categories if you want to hide only videos with this thumbnail feature.

Version 1.1.0 applies the authorized **Focused** preset once: Clickbait, Fear mongering, Rage bait, Engagement bait, Artificial urgency, and Wide-open mouth. Subsequent upgrades preserve selections. **Mouth only** and **All title categories** presets are also available, with individual checkboxes for all 22 categories. AI remains disabled on a new install until enabled; existing AI/action/threshold/key/keyword preferences are retained. It checks whether at least one visible human face has a very wide mouth opening; ordinary smiles or slightly parted lips are excluded by the rubric. It evaluates the actual thumbnail image, not the title. This is a probabilistic visual classification, not identity recognition. The shared minimum probability defaults to 90%; adjust it for your preferences. At 0%, every successful evaluation qualifies.

The classifier action applies to every selected AI category. You can also choose solid color, blur, grayscale, or placeholder instead of hiding. Keyword actions and colors remain independent and take priority, so keyword matches never incur an AI request.

## Preserved features

- Whole-word and phrase matching, case-insensitive Unicode normalization, editable keyword chips, multi-line paste, text editing, and removal of all keywords.
- All 21 original title rubrics: clickbait, fear mongering, rage bait, divisive framing, personal drama, celebrity gossip, gambling promotion, get-rich-quick promises, miracle-cure claims, shopping pressure, engagement bait, artificial urgency, conspiracy framing, spoilers, financial price predictions, crypto/NFT promotion, reaction content, harassment pranks, giveaways/contests, sponsorships/sales pitches, and rankings/listicles.
- Independent keyword and classifier actions: solid color, blur, grayscale, placeholder, and hide the entire video card. Custom colors, category/probability labels, rounded thumbnail bounds, and suppressed hover previews. Main video playback and links remain usable.
- A probability slider and number input, category groups, themes, keyboard navigation, tab draft indicators, Save/Discard, and an immediate master pause switch.
- Home, search, subscriptions, channels, Shorts listings, playlists, watch recommendations, end-screen suggestions, infinite scrolling, and YouTube navigation/recycled cards.
- New requests require a visible document and at least 25% thumbnail visibility continuously for 300 ms. Two API calls and two image preparations can execute at once. Per-evidence/category reservations share work across cards, tabs, and URL variants; cancellation, pre-dispatch cache/relevance checks, timeouts, authentication/rate-limit status, and saved-key tests remain supported.
- Persistent 30-day title and seven-day image score caching, separate 5,000-entry LRU limits, and a combined 4 MiB budget including aliases and failure metadata. Credential ownership, model, question instruction fingerprints, and image profiles control compatibility.
- Analytics: estimated spend for today, this week, this month, and all time; requests, key tests, tokens, pending/unresolved/unpriced usage, saved calendar time zone, and durable billing history.
- Filtering patterns: actual viewport encounters, keyword/category overlap, winning labels, periods, chart/table views, rate comparisons, rule-change markers, and 90-day local retention.

## API and image handling

The worker sends authenticated `POST https://api.openai.com/v1/decisions` requests with `model: "gpt-6-luna"`. Title categories use a plain-string `input` and named `predicate` questions. Image requests use a user message with `input_text` and an inline base64 `input_image`; external image URLs are not sent as API image input. Only missing selected questions are requested. The guide currently identifies Decisions as a public beta with this model.

Answers are matched by name, never response position. Independently valid, uniquely named predicates with finite probabilities between 0 and 1 are cached even when another question fails. Missing, duplicate, malformed, and refused questions remain unresolved. Only unresolved malformed/missing questions retry once after 60 seconds while relevant; a second failure or a refusal receives a one-hour per-question cooldown. Full selected results are required for normal filtering. TypeSafe and legacy cache formats are discarded; the new cache format is 2 with per-question compatibility fingerprints.

**Skip thumbnails after a title match** is enabled by default and applies only to **Hide entire video**. Missing title questions run first; a title match can skip image downloading and classification. Results explicitly identify evaluated and skipped categories. Skipped categories are excluded from evaluated/qualified counts, never treated as negative. Other actions evaluate all selected evidence. Style, threshold, and early-exit changes recompute decisions from compatible complete scores; partial early exits return to the worker for missing evidence.

Only selecting **Wide-open mouth** enables thumbnail downloads/uploads. The worker accepts HTTPS static thumbnail paths from `i.ytimg.com`, `i1`–`i4.ytimg.com`, or `img.youtube.com`, rejects redirects and other origins, omits cookies and referrers, checks JPEG/PNG/WebP/AVIF content types, and caps streamed downloads at 5 MiB. Decoded images are limited to 16 megapixels. YouTube can return AVIF at a `.jpg` URL; Chrome decodes it and converts it to supported PNG. No API key is sent to image hosts.

**Thumbnail size** offers Original, 768 px, and 512 px maximum edges, preserving aspect ratio without enlargement for all supported formats. **Image detail** offers High, Low, and Auto. Defaults remain Original and High: JPEG/PNG/WebP retain their dimensions, and AVIF conversion retains the existing 1,536-pixel cap. Resized/converted uploads are lossless PNG. Smaller images may miss small faces; lower detail is not assumed cheaper. No paid benchmark has been run.

Title scores use the exact trimmed-title hash. Image scores use a hash of the original decoded dimensions/RGBA pixels, plus the image processing profile and uploaded dimensions. Identical verified content at different URLs can reuse scores; compression variants with different decoded pixels remain separate. Exact URL hashes map to verified content for one hour, after which the image is downloaded and hashed again. Unchanged pixels reuse the seven-day score; changed pixels require a new decision. A change at the same URL can therefore remain cached for up to one hour. Image data is held only in memory during preparation/dispatch and never persisted by the extension. Changed sources cancel stale page subscriptions, and late results cannot filter a recycled thumbnail.

Missing image sources allow available title categories to be evaluated. Failed image preparation never fabricates a mouth score and adds no paid API attempt. Keyword matches retain priority and bypass AI.

## Spend and privacy

[Decisions-specific pricing](https://developers.openai.com/api/docs/guides/decisions#pricing-and-availability), checked October 6, 2026: GPT-6 Luna costs **$0.10 per million input tokens**, with no cache-read, cache-write, or output-token charges. The whole request uses $0.20 per million input tokens above 272,000 reported input tokens. This extension uses the standard `api.openai.com` endpoint and bounded inputs; its estimates use this Decisions rate, not Responses pricing. Image input tokens are included in reported usage. Downloads and cache hits do not count as paid API attempts. Unknown model rates are marked unpriced; interrupted requests are unresolved. Credits, taxes, discounts, and usage in other apps are excluded. No model-accuracy or paid-cost benchmark has been performed.

Settings and the API key are saved locally, never synced. The worker restricts `chrome.storage.local` to trusted extension contexts and publishes key-free settings to content scripts using session storage. The saved key is not redisplayed, placed in the page DOM, or logged. Thumbnail hosts never receive the key. Chrome extension storage is not an encrypted credential vault; browser-profile access can expose it. This is a personal bring-your-own-key extension. Do not embed a shared production key in a distributed build; use a service you control if distributing shared credentials.

Only YouTube content scripts, the OpenAI API host, and YouTube thumbnail hosts are permitted. The only extension API permission is `storage`. There are no hardcoded credentials, remote scripts, telemetry, identity/camera/microphone permissions, or Swift/RealityKit entitlements. Titles and opted-in thumbnails are sent to OpenAI for classification. Analytics stays local and does not retain raw images, titles, or API keys. Removing the key disables AI; uninstalling removes saved settings/history.

## Development and verification

```sh
npm test
npm run build
npm run audit:payload
node scripts/preview.mjs
```

The offline payload audit compares the previous and compact production title-only JSON character counts for 1, 12, and 21 questions. The 21-question payload decreased from 10,115 to 8,330 characters (17.6%). Characters are not tokens or cost estimates. It reads no keys and makes no API calls.

The development preview runs at `http://127.0.0.1:4317` with simulated AI and in-memory settings. `/?long=1` tests long keyword lists; `/?spend=zero`, `tiny`, `large`, `pending`, `incomplete`, or `storage` exercise accounting states; `/fixture.html` checks thumbnail layouts; `/hover-fixture.html` checks preview playback. No preview key is real. Do not enter a real key into the preview. Preview scripts and tests are excluded from the built extension.

Tests use Node's test runner, jsdom, the real worker/content scripts, mocked Chrome APIs, and mocked HTTP responses. They cover the preserved features plus the Decisions wire format, refusal/name validation, inline image encoding, host/size restrictions, independent image caching, optional uploads, no billing before image preparation, failed-download recovery, stale-image cancellation, mouth-only hiding, and restoration.

Builds validate Manifest V3, permissions, required files, and JavaScript syntax before creating the unpacked directory. See [VALIDATION.md](VALIDATION.md) for the checks performed and remaining manual checks. Version 1.1.0 verification was offline, including 27 native browser decode/resize/fingerprint checks on the three supplied screenshots in PNG, JPEG, and WebP at all sizes. This verifies processing, not model classification accuracy. The CLI environment has no OpenAI key. Earlier native Chrome inspection of the installed extension subsequently reproduced an AVIF loading error and confirmed a live Connected state after the version 1.0.1 fix. Classification accuracy on a labeled image set has not been benchmarked.

## Manual verification

- Load the built directory in Chrome, refresh YouTube, save your key, and run **Test saved key**. Check extension errors at `chrome://extensions`.
- Select only **Wide-open mouth**, enable AI, choose **Hide entire video**, and save. Compare wide-open mouths against closed mouths, normal smiles, and thumbnails without faces; verify the selected probability threshold.
- Check Home, search, subscriptions, channels, Shorts listings, playlists, recommendations, and end screens. Scroll and navigate without a refresh. Replace a thumbnail on a recycled card and confirm its old score is not applied.
- Change classifier style/color/threshold, then disable the image category or pause filtering. Confirm restoration and that keywords keep their separate action.
- Verify dark/light themes, keyboard navigation, Save/Discard, category persistence, and connection errors. Change/remove the key and verify AI stops.
- Inspect Analytics and Filtering patterns. Confirm image API calls count once, thumbnail downloads/cache hits add no spend, and the chart/table agree. Restart Chrome and verify title/image score reuse; after one hour, image URLs are reverified without an API call when pixels are unchanged.
