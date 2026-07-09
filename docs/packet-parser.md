# Packet Parser Notes

`PACKET-002` makes packet parsing review-friendly instead of pretending every Army hand receipt is clean.

## Supported Inputs

- Clean PDF text extracted from Army-style hand receipt tables.
- Messy PDF text where an item is split across MPO, LIN, description, NSN, and quantity lines.
- One-line fallback rows such as `A90594 ARMAMENT SUBSYS: M153`.
- Pipe or tab delimited paste rows in the shape `packet row | qty | location`.

## Extracted Fields

The parser extracts these fields when present:

- `mpo`
- `lin`
- `nsn`
- `description`
- `expectedQty`
- `locationHint`
- `confidence`

The current import API stores `packetLine`, `expectedQty`, and `locationHint`, so structured fields are used to compose a cleaner review row without changing the backend schema.

## Noise Handling

The parser ignores common packet noise:

- Page headers and footers.
- `Sub Hand Receipt`, `From`, `To`, `FE`, `UIC`, `Date`, `Time`, and `Page` lines.
- Column headers such as `MPO Description`, `NSN Description`, `SerNo/RegNo/LotNo`, `UI`, `CIIC`, `DLA`, `BUoM`, and `OH Qty`.
- Signature, stamp, image, and embedded-photo text that can appear in PDF extraction.

## Fixtures

Regenerate PDF fixtures with:

```powershell
$py='C:\Users\tmlew\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
& $py scripts/generate-packet-fixtures.py
```

Generated files live in `output/pdf/`:

- `army-packet-clean.pdf`
- `army-packet-clean.txt`
- `army-packet-weird-layout.pdf`
- `army-packet-weird-layout.txt`

Run parser checks with:

```powershell
npm run check:packet
```

## Known Limits

- Photos of paper still depend on OCR quality before parser rules run.
- Handwriting is intentionally ignored.
- The review screen does not store `mpo`, `lin`, `nsn`, or `description` separately yet; that belongs in a later schema task if needed.
