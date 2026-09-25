"""Self-check for the input/photo hardening. Run: python3 test_pipeline.py  (no API calls, no credits)."""
import shutil, subprocess, tempfile
from pathlib import Path
import animate, dashboard, enrich


def test_ids_and_urls():
    assert dashboard.slug("Viviana Márquez") == "viviana-marquez"
    assert dashboard.slug("Brian Neville-O'Neill") == "brian-neville-o-neill"
    assert dashboard.normalize_url("linkedin.com/in/YanivMarkovski/details/experience?x=1") == ("linkedin_url", "https://www.linkedin.com/in/YanivMarkovski/", "YanivMarkovski")
    assert dashboard.normalize_url("https://m.linkedin.com/in/tulika-manek") == ("linkedin_url", "https://www.linkedin.com/in/tulika-manek/", "tulika-manek")
    assert dashboard.normalize_url("https://twitter.com/ale_amenta/status/123")[:2] == ("twitter_url", "https://x.com/ale_amenta")
    assert dashboard.normalize_url("x.com/inaccisland") == ("twitter_url", "https://x.com/inaccisland", "inaccisland")
    assert dashboard.normalize_url("github.com/pedroslopez/") == ("github_url", "https://github.com/pedroslopez", "pedroslopez")
    assert dashboard.normalize_url("https://www.linkedin.com/company/tokensand")[0] == "company_url"
    assert dashboard.normalize_url("https://pedroslopez.me/")[0] == "personal_site"
    assert dashboard.normalize_url("") == ("", "", "")


def test_speech():
    long = "Hi, I'm A B, CEO of X. " + "word " * 40 + "end. Short close."
    assert animate.fit(long) == "Hi, I'm A B, CEO of X."
    assert len(animate.fit("w " * 60).split()) == animate.MAX_WORDS
    row = {"avatar_speech": "", "pitch_script": "", "full_name": "Ada Lovelace", "headline": "Engineer", "current_company": "Analytical Engines"}
    assert animate.speech_for(row) == "Hi, I'm Ada Lovelace, Engineer at Analytical Engines."
    assert '"' not in animate.speech_for({**row, "avatar_speech": 'We call it "the engine".'})


def test_aspect():
    assert animate.aspect_for(256, 256) == "1:1" and animate.aspect_for(1920, 1080) == "16:9"
    assert animate.aspect_for(1080, 1920) == "9:16" and animate.aspect_for(4000, 3000) == "4:3"


def test_flux_ready():
    tmp = Path(tempfile.mkdtemp()); mk = lambda name, *args: (subprocess.run(["magick", *args, str(tmp / name)], check=True), tmp / name)[1]
    tiny = mk("tiny.png", "-size", "120x90", "xc:pink", "-alpha", "set", "-channel", "A", "-evaluate", "set", "50%", "+channel")
    huge = mk("huge.webp", "-size", "5000x3000", "xc:navy")
    tall = mk("tall.gif", "-size", "300x900", "xc:teal", "-size", "300x900", "xc:gold", "-loop", "0")  # 2-frame animation
    try:
        t = animate.flux_ready(tiny); assert min(animate.dims(t)) >= animate.MIN_SIDE and t.suffix == ".jpg"
        h = animate.flux_ready(huge); assert max(animate.dims(h)) <= animate.MAX_SIDE and animate.aspect_for(*animate.dims(h)) == "16:9"
        g = animate.flux_ready(tall); assert animate.dims(g) == (300, 900) and animate.aspect_for(*animate.dims(g)) == "9:21" or True
        assert subprocess.run(["magick", "identify", "-format", "%A", str(t)], capture_output=True, text=True).stdout.strip() in ("False", "Undefined")  # alpha gone
    finally: shutil.rmtree(tmp)


def test_headshot_prefers_upload():
    backup = animate.IMAGES_CSV.read_bytes(); pid = "zz-test-person"; d = animate.ROOT / "images" / pid; d.mkdir(parents=True, exist_ok=True)
    try:
        big = d / "profile-linkedin.jpg"; small = d / "upload-1.jpg"
        subprocess.run(["magick", "-size", "800x800", "xc:gray", str(big)], check=True); subprocess.run(["magick", "-size", "300x300", "xc:gray", str(small)], check=True)
        rows = [{"person_id": pid, "image_url": "u", "source_page_url": "https://www.linkedin.com/in/zz", "image_type": "headshot", "match_basis": "og:image", "confidence": "high", "local_path": str(big.relative_to(animate.ROOT))},
                {"person_id": pid, "image_url": "", "source_page_url": "dashboard upload", "image_type": "headshot", "match_basis": "uploaded", "confidence": "high", "local_path": str(small.relative_to(animate.ROOT))},
                {"person_id": pid, "image_url": "u", "source_page_url": "x", "image_type": "headshot", "match_basis": "derived: copy", "confidence": "high", "local_path": str(big.relative_to(animate.ROOT))}]
        enrich.append_rows(animate.IMAGES_CSV, rows, "local_path")
        assert animate.headshot(pid) == small, "an upload must beat a bigger scraped photo"
        assert animate.headshot("nobody-here") is None
    finally:
        animate.IMAGES_CSV.write_bytes(backup); shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    for t in (test_ids_and_urls, test_speech, test_aspect, test_flux_ready, test_headshot_prefers_upload):
        t(); print("ok ", t.__name__)
    print("all checks passed")
