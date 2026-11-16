"""Generate Vishnu artwork for the app with Gemini image models.

Usage: GEMINI_API_KEY=... python3 scripts/gen_art.py [name ...]
Writes art/<name>.png. With no names, generates every prompt below.
"""
import base64, json, os, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

MODEL = "gemini-3-pro-image"
OUT = os.path.join(os.path.dirname(__file__), "..", "art")

STYLE = ("Cinematic devotional digital painting, Interstellar film atmosphere, volumetric light, "
         "ultra detailed, majestic and serene, no text, no watermark, no signature.")

FIGURE = ("Lord Vishnu in his Vishwaroop universal form, colossal, full body standing, front view, "
          "serene closed-eye smile, luminous blue skin, tall golden kireeta crown, gold jewellery and "
          "vanamala garland, flowing yellow silk pitambar, many arms fanned out in a radiant circle holding "
          "the Sudarshan chakra, shankha conch, gada mace and pink lotus. Soft golden rim light. "
          "Isolated on a pure solid black background, nothing else in the frame, figure centered with space around it. ")

PROMPTS = {
    "figure-vishwaroop": FIGURE + STYLE,
    "figure-vishwaroop-gargantua": FIGURE.replace("Soft golden rim light.",
        "Behind his head a black hole halo like Gargantua from Interstellar, a black disc ringed by a thin "
        "blazing photon ring with a flat golden accretion disc crossing behind him.") + STYLE,
    "sky-gargantua": ("A colossal Lord Vishnu in Vishwaroop form towering across deep space, blue skin, golden "
        "crown and ornaments, yellow pitambar, many arms holding chakra, conch, mace and lotus, his halo is the "
        "Gargantua black hole from Interstellar with a blazing accretion disc. Amber and teal nebulae, distant "
        "planets, drifting golden embers. Composition: the figure and halo fill the upper two thirds, the bottom "
        "third is soft dark cosmic haze. Vertical. " + STYLE),
    "sky-cosmic-ocean": ("Lord Vishnu reclining on the coiled serpent Shesha in the cosmic ocean Ksheer Sagar, "
        "which floats among galaxies, amber and gold nebula above, deep teal luminous waters, pink lotuses and "
        "golden petals drifting, planets in the sky. Seen from below as if looking up at an immense vision in the "
        "sky. Subject in the upper two thirds, bottom third soft haze. Vertical. " + STYLE),
    "sky-divine-foot": ("Worm's-eye view looking straight up into the sky: the gigantic blue right foot of Lord "
        "Vishnu stepping down towards the viewer through towering sunlit clouds, the sole facing us, toes at the "
        "top, heel at the bottom, all five toes visible, the sole marked with a golden lotus, conch and chakra, "
        "golden light rimming it. High above the foot, small with distance, the multi-armed Vishnu with a golden "
        "crown and yellow silk scarf billowing. No rocks or ground in the frame. "
        "Overwhelming sense of scale, heavenly daylight sky. Vertical. " + STYLE),
    "sky-anantashayana": ("Lord Vishnu reclining serenely on a bed of glowing golden cosmic clouds and stars, blue "
        "skin, golden crown, silk garments, galaxies and star fields around him, warm gold and violet nebula, "
        "immense like a constellation across the sky. Subject in the upper two thirds. Vertical. " + STYLE),
}

def generate(name):
    body = {"contents": [{"parts": [{"text": PROMPTS[name]}]}],
            "generationConfig": {"responseModalities": ["IMAGE"],
                                 "imageConfig": {"aspectRatio": "9:16", "imageSize": "2K"}}}
    req = urllib.request.Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent",
        data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json", "x-goog-api-key": os.environ["GEMINI_API_KEY"]})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        return f"{name}: HTTP {e.code} {e.read()[:300]!r}"
    for cand in data.get("candidates", []):
        for part in cand.get("content", {}).get("parts", []):
            if "inlineData" in part:
                path = os.path.join(OUT, name + ".png")
                with open(path, "wb") as f:
                    f.write(base64.b64decode(part["inlineData"]["data"]))
                return f"{name}: ok"
    return f"{name}: no image ({json.dumps(data)[:300]})"

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    names = sys.argv[1:] or list(PROMPTS)
    with ThreadPoolExecutor(6) as ex:
        for line in ex.map(generate, names):
            print(line, flush=True)
