from pathlib import Path
import json
import re
import textwrap
from urllib.request import urlopen

import pdfplumber
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas


OUTPUT_DIR = Path("output/pdf")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

LEGACY_INVENTORY_URL = "https://ms-inventories.s3.us-east-1.amazonaws.com/inventories/ms.json"
PAGE_WIDTH, PAGE_HEIGHT = letter
ROWS_PER_PAGE = 6
ROW_HEIGHT = 76
TABLE_X = 38
TABLE_WIDTH = 536


def fetch_live_inventory_items():
    with urlopen(LEGACY_INVENTORY_URL, timeout=20) as response:
        data = json.loads(response.read().decode("utf-8"))
    return data["items"]


def field_value(item, label):
    for field in item.get("fields", []):
        if field.get("label") == label:
            value = field.get("value", "")
            if isinstance(value, list):
                return ", ".join(str(part) for part in value if part)
            return str(value or "")
    return ""


def clean_cell(value):
    return re.sub(r"\s+", " ", str(value or "").strip())


def split_title(title):
    value = clean_cell(title).upper()
    match = re.match(r"^([A-Z0-9]{5,8})\s+(.+)$", value)
    if not match:
        return "", value

    maybe_lin = match.group(1)
    has_letter = re.search(r"[A-Z]", maybe_lin)
    has_digit = re.search(r"\d", maybe_lin)
    if has_letter and has_digit:
        return maybe_lin, match.group(2)
    return "", value


def clean_nsn(value):
    value = clean_cell(value).upper()
    if value in {"", "N/A", "NA", "NONE", "(NOT SPECIFIED)"}:
        return ""
    return value


def clean_qty(value):
    value = clean_cell(value)
    match = re.search(r"\d+", value)
    return match.group(0) if match else ""


def legacy_items_to_packet_rows(items):
    rows = []
    for index, item in enumerate(items, start=1):
        lin, description = split_title(item.get("title", ""))
        nsn = clean_nsn(field_value(item, "NSN"))
        rows.append(
            {
                "mpo": f"{index:09d}",
                "lin": lin,
                "description": description,
                "nsn": nsn,
                "nsn_description": description,
                "ui": "EA",
                "ciic": "",
                "dla": "",
                "buom": "EA",
                "qty": clean_qty(field_value(item, "OH Qty")),
            }
        )
    return rows


def draw_wrapped(page, x, y, text, width_chars, line_height, max_lines, font="Helvetica", size=6.5):
    page.setFont(font, size)
    lines = textwrap.wrap(clean_cell(text), width=width_chars) or [""]
    for offset, line in enumerate(lines[:max_lines]):
        page.drawString(x, y - offset * line_height, line)


def draw_header(page, page_number, page_count, platoon_name="B1P6 MS/2ND"):
    page.setFont("Helvetica-Bold", 10)
    page.drawCentredString(PAGE_WIDTH / 2, 704, "Sub Hand Receipt")
    page.setFont("Helvetica", 7)
    page.drawString(58, 656, "From:")
    page.drawString(100, 656, "Responsible Officer")
    page.drawString(58, 642, "To:")
    page.drawString(100, 642, platoon_name)
    page.drawString(58, 628, "FE:")
    page.drawString(100, 628, "40284975")
    page.drawString(58, 614, "UIC:")
    page.drawString(100, 614, "WPN280PB W25VH8 0876 EN BN CO B COMBAT ENG")
    page.drawString(486, 656, "Date: 2025-12-06")
    page.drawString(486, 642, "Time: 13:37:42")
    page.drawString(486, 628, f"Page {page_number} of {page_count}")


def draw_table_row(page, y, item, variant="clean"):
    x = TABLE_X
    page.setStrokeColor(colors.black)
    page.setLineWidth(0.45)
    page.rect(x, y - 21, TABLE_WIDTH, ROW_HEIGHT)
    page.setFillColor(colors.lightgrey)
    page.rect(x, y + 39, TABLE_WIDTH, 16, fill=1, stroke=1)
    page.setFillColor(colors.black)
    page.setFont("Helvetica-Bold", 5.8)
    page.drawString(x + 6, y + 44, "MPO")
    page.drawString(x + 76, y + 44, "MPO Description")

    row_title = f"{item['lin']} {item['description']}".strip()
    page.setFont("Helvetica", 6.6)
    page.drawString(x + 6, y + 25, item["mpo"])
    draw_wrapped(page, x + 76, y + 25, row_title, 74, 8, 2)

    page.setFont("Helvetica-Bold", 5.2)
    page.drawString(x + 6, y + 5, "NSN")
    page.drawString(x + 124, y + 5, "NSN Description")
    page.drawString(x + 358, y + 5, "UI")
    page.drawString(x + 390, y + 5, "CIIC")
    page.drawString(x + 424, y + 5, "DLA")
    page.drawString(x + 460, y + 5, "BUoM")
    page.drawString(x + 498, y + 5, "OH Qty")

    page.setFont("Helvetica", 5.4)
    page.drawString(x + 6, y - 8, item["nsn"])
    nsn_description = item["nsn_description"] if item["nsn"] else ""
    draw_wrapped(page, x + 124, y - 8, nsn_description, 54, 7, 1, size=5.4)
    page.drawString(x + 358, y - 8, item["ui"])
    page.drawString(x + 390, y - 8, item["ciic"])
    page.drawString(x + 424, y - 8, item["dla"])
    page.drawString(x + 460, y - 8, item["buom"])
    page.drawString(x + 506, y - 8, item["qty"])

    if variant == "weird":
        page.setStrokeColor(colors.grey)
        page.setFillColor(colors.whitesmoke)
        page.rect(x + TABLE_WIDTH - 68, y + 16, 38, 26, fill=1, stroke=1)
        page.setFillColor(colors.black)


def draw_pages(path, items, variant="clean"):
    page = canvas.Canvas(str(path), pagesize=letter)
    page_count = (len(items) + ROWS_PER_PAGE - 1) // ROWS_PER_PAGE
    for page_index in range(page_count):
        draw_header(page, page_index + 1, page_count)
        start = page_index * ROWS_PER_PAGE
        y = 548
        for item in items[start : start + ROWS_PER_PAGE]:
            draw_table_row(page, y, item, variant)
            y -= ROW_HEIGHT + 9
        page.showPage()
    page.save()


def extract_text(pdf_path):
    with pdfplumber.open(pdf_path) as pdf:
        return "\n".join(page.extract_text() or "" for page in pdf.pages)


def main():
    items = legacy_items_to_packet_rows(fetch_live_inventory_items())
    for name, variant in [
        ("army-packet-clean.pdf", "clean"),
        ("army-packet-weird-layout.pdf", "weird"),
    ]:
        pdf_path = OUTPUT_DIR / name
        draw_pages(pdf_path, items, variant)
        text_path = pdf_path.with_suffix(".txt")
        text_path.write_text(extract_text(pdf_path), encoding="utf-8")
        print(f"wrote {pdf_path}")
        print(f"wrote {text_path}")
    print(f"packet rows: {len(items)}")


if __name__ == "__main__":
    main()
