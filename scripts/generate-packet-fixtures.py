from pathlib import Path

import pdfplumber
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas


OUTPUT_DIR = Path("output/pdf")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


ITEMS = [
    {
        "mpo": "000009148",
        "lin": "R20684",
        "description": "RADIAC SET: AN/VDR-2",
        "nsn": "6665012221425",
        "nsn_description": "RADIAC SET AN/VDR-2",
        "ui": "EA",
        "ciic": "7",
        "dla": "5156",
        "buom": "EA",
        "qty": "1",
    },
    {
        "mpo": "000004336",
        "lin": "N96248",
        "description": "NAVIGATION SET: SATELLITE SIGNALS AN/PSN",
        "nsn": "5825015264763",
        "nsn_description": "NA SE 5A AN/PSN-13(A)",
        "ui": "EA",
        "ciic": "0",
        "dla": "1237",
        "buom": "EA",
        "qty": "4",
    },
    {
        "mpo": "0000186033",
        "lin": "M05000",
        "description": "TAMPER,VIBRATING TYPE,INTERNAL COMBUST",
        "nsn": "3805014824487",
        "nsn_description": "TAMPER,VIBRATING TYPE INTERNAL COMBUST",
        "ui": "EA",
        "ciic": "0",
        "dla": "7317",
        "buom": "EA",
        "qty": "2",
    },
]


def header(page, title="Sub Hand Receipt"):
    page.setFont("Helvetica-Bold", 10)
    page.drawCentredString(306, 690, title)
    page.setFont("Helvetica", 7)
    page.drawString(58, 642, "From:")
    page.drawString(98, 642, "Responsible Officer")
    page.drawString(58, 628, "To:")
    page.drawString(98, 628, "B1P6 MS/2ND")
    page.drawString(58, 614, "FE:")
    page.drawString(98, 614, "40284975")
    page.drawString(58, 600, "UIC:")
    page.drawString(98, 600, "WPN280PB W25VH8 0876 EN BN CO B COMBAT ENG")
    page.drawString(486, 642, "Date: 2025-12-06")
    page.drawString(486, 628, "Time: 13:37:42")
    page.drawString(486, 614, "Page 1 of 1")


def draw_table_row(page, y, item):
    x = 42
    width = 528
    page.setStrokeColor(colors.black)
    page.setLineWidth(0.5)
    page.rect(x, y - 4, width, 52)
    page.setFillColor(colors.lightgrey)
    page.rect(x, y + 30, width, 18, fill=1, stroke=1)
    page.setFillColor(colors.black)
    page.setFont("Helvetica-Bold", 6)
    page.drawString(x + 6, y + 36, "MPO")
    page.drawString(x + 72, y + 36, "MPO Description")
    page.setFont("Helvetica", 7)
    page.drawString(x + 6, y + 18, item["mpo"])
    page.drawString(x + 72, y + 18, f'{item["lin"]} {item["description"]}')
    page.setFont("Helvetica-Bold", 5.5)
    page.drawString(x + 6, y + 4, "NSN")
    page.drawString(x + 124, y + 4, "NSN Description")
    page.drawString(x + 358, y + 4, "UI")
    page.drawString(x + 392, y + 4, "CIIC")
    page.drawString(x + 424, y + 4, "DLA")
    page.drawString(x + 462, y + 4, "BUoM")
    page.drawString(x + 500, y + 4, "OH Qty")
    page.setFont("Helvetica", 5.5)
    page.drawString(x + 6, y - 8, item["nsn"])
    page.drawString(x + 124, y - 8, item["nsn_description"])
    page.drawString(x + 358, y - 8, item["ui"])
    page.drawString(x + 392, y - 8, item["ciic"])
    page.drawString(x + 424, y - 8, item["dla"])
    page.drawString(x + 462, y - 8, item["buom"])
    page.drawString(x + 506, y - 8, item["qty"])


def build_clean_pdf(path):
    page = canvas.Canvas(str(path), pagesize=letter)
    header(page)
    y = 550
    for item in ITEMS:
        draw_table_row(page, y, item)
        y -= 78
    page.showPage()
    page.save()


def build_weird_pdf(path):
    page = canvas.Canvas(str(path), pagesize=letter)
    header(page)
    page.setStrokeColor(colors.lightgrey)
    page.setFillColor(colors.whitesmoke)
    page.rect(400, 450, 128, 82, fill=1, stroke=1)
    page.setFillColor(colors.grey)
    page.setFont("Helvetica-Bold", 9)
    page.drawString(420, 492, "EMBEDDED PHOTO")
    page.setFillColor(colors.black)
    y = 545
    for item in ITEMS[:2]:
        page.setFont("Helvetica-Bold", 6)
        page.drawString(50, y, "MPO Description")
        page.setFont("Helvetica", 7)
        page.drawString(50, y - 14, item["mpo"])
        page.drawString(116, y - 14, item["lin"])
        page.drawString(170, y - 14, item["description"])
        page.drawString(50, y - 30, item["nsn"])
        page.drawString(150, y - 30, item["nsn_description"])
        page.drawString(424, y - 30, item["ui"])
        page.drawString(448, y - 30, item["ciic"])
        page.drawString(474, y - 30, item["dla"])
        page.drawString(510, y - 30, item["buom"])
        page.drawString(540, y - 30, item["qty"])
        page.setFont("Helvetica-Oblique", 7)
        page.drawString(360, y - 12, "signature block")
        y -= 94

    item = ITEMS[2]
    page.setFont("Helvetica-Bold", 6)
    page.drawString(50, y, "MPO Description")
    page.setFont("Helvetica", 7)
    page.drawString(50, y - 14, item["mpo"])
    page.drawString(50, y - 28, item["lin"])
    page.drawString(50, y - 42, item["description"])
    page.drawString(50, y - 58, item["nsn"])
    page.drawString(50, y - 72, f'{item["nsn_description"]} {item["ui"]} {item["ciic"]} {item["dla"]} {item["buom"]} {item["qty"]}')
    page.showPage()
    page.save()


def extract_text(pdf_path):
    with pdfplumber.open(pdf_path) as pdf:
        return "\n".join(page.extract_text() or "" for page in pdf.pages)


def main():
    for name, builder in [
        ("army-packet-clean.pdf", build_clean_pdf),
        ("army-packet-weird-layout.pdf", build_weird_pdf),
    ]:
        pdf_path = OUTPUT_DIR / name
        builder(pdf_path)
        text_path = pdf_path.with_suffix(".txt")
        text_path.write_text(extract_text(pdf_path), encoding="utf-8")
        print(f"wrote {pdf_path}")
        print(f"wrote {text_path}")


if __name__ == "__main__":
    main()
