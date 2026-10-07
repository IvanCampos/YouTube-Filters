# YouTube Filters

Make your YouTube feed easier to browse. Hide videos with words you don't want to see, or use optional AI filters for clickbait, rage bait, spoilers, wide-open-mouth thumbnails, and brush-styled thumbnail text.

## What you can do

- Filter video titles using your own words and phrases.
- Choose AI categories, including **Mouth only** and **AI Brushed Images** options for thumbnails.
- Hide matching videos, cover their thumbnails, blur them, or make them grayscale.
- View filtering activity and estimated AI spending in **Analytics**.
- Pause everything with the **Filtering** switch.

## Install in Chrome

1. On GitHub, select **Code → Download ZIP**.
2. Unzip the download and keep the extracted folder on your computer.
3. In Chrome, enter `chrome://extensions` in the address bar.
4. Turn on **Developer mode** in the top-right corner.
5. Select **Load unpacked**, then choose the **extension** folder inside the extracted project.
6. Refresh your YouTube tabs. Open Chrome's puzzle-piece menu and pin **YouTube Thumbnail Filters — Decisions** for easy access.

<img width="2029" height="1017" alt="Screenshot 2026-10-06 at 10 32 00 PM" src="https://github.com/user-attachments/assets/4ff61001-56dc-4d5f-be7b-bd101ace1b27" />

## Start with keyword filters

Keyword filters work without an OpenAI account or paid AI requests.

1. Open the extension and select **Keywords**.
2. Add words or phrases you want to filter, such as `spoiler` or `reaction`. Capitalization doesn't matter.
3. Under **On a match**, choose **Hide entire video** or a thumbnail effect.
4. Select **Save all settings**.

Words match whole words: `cat` matches “cat videos,” but not “vacation.”

## Turn on optional AI filters

AI filters require your own OpenAI API key, which connects the extension to your OpenAI account. OpenAI charges for these AI checks.

1. Open **Classifiers**, then expand **OpenAI Decisions connection**.
2. Use **Get a key from OpenAI Decisions** to open OpenAI's key page. Paste your key into the extension and select **Save all settings**.
3. Turn on **Classify with OpenAI Decisions**.
4. Choose categories individually, or use **Quick selection**:
   - **Focused:** Clickbait, fear mongering, rage bait, engagement bait, artificial urgency, and wide-open mouths.
   - **Mouth only:** Wide-open-mouth thumbnails.
   - **AI Brushed Images:** Brush lettering or clean lettering on a brush banner.
   - **All title categories:** All available title filters.
5. Choose what happens **On a match**, then select **Save all settings**.

To hide wide-open-mouth videos, choose **Mouth only** and **Hide entire video**. This checks the thumbnail image. Ordinary smiles and slightly parted lips are intended to stay visible, though AI can make mistakes.

To filter brush-styled thumbnails, choose **AI Brushed Images** or select its categories individually:

- **Brush lettering only** (`brush_lettering_only`): The letters themselves have rough, bristled, painted strokes. Solid-filled digital brush fonts count when their stroke edges are frayed, feathered, or tapered; paint texture inside the letters is not required.
- **Brush background only** (`brush_background_only`): Clean lettering sits on a separate rough paintbrush banner or swash.

With both selected, either category reaching your minimum match probability counts as a hit. Brush-textured letters can qualify even when a brush banner is also present. These options start unselected and classify visible styling without determining whether AI created the image. Choose **Hide entire video** or a thumbnail effect, then **Save all settings**.

<img width="397" height="586" alt="Screenshot 2026-10-06 at 10 07 09 PM" src="https://github.com/user-attachments/assets/d46db727-4b2d-4ed8-8e7b-7ca8d3d96efc" />

After updating the extension's classifier rubrics, reload the extension at `chrome://extensions` and refresh YouTube tabs. The changed category's cached scores are discarded on worker restart; other categories keep their compatible cached scores.

**Minimum match probability** controls how strong an AI match must be before filtering. Start with the default **90%**; lowering it filters more videos. It does not affect keyword filters.

## Cost and privacy

- AI filtering and **Test saved key** use paid OpenAI requests. **Analytics** shows estimates for this extension, not your complete OpenAI bill.
- Keyword matches skip AI checks, and previous results can be reused to reduce repeated requests.
- AI checks send video titles to OpenAI. Selecting **Wide-open mouth** or either **AI Brushed Images** category also sends thumbnail images.
- Your settings, API key, and filtering history stay in your browser and do not sync between devices. Keep your key private; someone with access to your browser profile may be able to read it.
- AI starts turned off. You can remove your key or turn off AI at any time.

## If something isn't working

- Confirm the extension is enabled at `chrome://extensions`, then refresh YouTube.
- Check that **Filtering** is on and select **Save all settings** after changing your filters.
- For AI filters, check your saved key, selected categories, and OpenAI account billing. **Test saved key** checks the connection using a paid API request.
- If too much is hidden, raise **Minimum match probability** or choose fewer categories.
