#!/usr/bin/env python3
"""Génère les gros fichiers du test de performance (non commités, idempotent).

Usage : generate.py <dossier>
"""
import json
import os
import random
import sqlite3
import struct
import sys
import zipfile
import zlib

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
rnd = random.Random(42)


def target(name):
    path = os.path.join(out, name)
    return None if os.path.exists(path) else path


def text_50mb():
    path = target("text-50mb.rs")
    if not path:
        return
    line = "    let value_{i} = compute_something(&input[{i} % 97], {i} * 31 + 7); // ligne de code {i}\n"
    with open(path, "w") as f:
        size, i = 0, 0
        while size < 50 * 1024 * 1024:
            s = line.format(i=i)
            f.write(s)
            size += len(s)
            i += 1


def csv_50mb():
    path = target("csv-50mb.csv")
    if not path:
        return
    with open(path, "w") as f:
        f.write("id,nom,ville,montant,quantite,commentaire\n")
        size, i = 0, 0
        while size < 50 * 1024 * 1024:
            s = f"{i},Nom{i % 9973},Ville{i % 311},{(i * 37 % 100000) / 100:.2f},{i % 50},commentaire de la ligne {i} lorem ipsum\n"
            f.write(s)
            size += len(s)
            i += 1


def json_20mb():
    path = target("json-20mb.json")
    if not path:
        return
    with open(path, "w") as f:
        f.write("[")
        size, i = 0, 0
        while size < 20 * 1024 * 1024:
            s = json.dumps(
                {
                    "id": i,
                    "name": f"item-{i}",
                    "tags": ["a", "b", str(i % 7)],
                    "price": i / 3,
                    "ok": i % 2 == 0,
                    "nested": {"x": i, "y": [i, i + 1]},
                }
            )
            f.write(("," if i else "") + s)
            size += len(s)
            i += 1
        f.write("]")


def binary_200mb():
    path = target("binary-200mb.bin")
    if not path:
        return
    block = rnd.randbytes(1024 * 1024)
    with open(path, "wb") as f:
        for _ in range(200):
            f.write(block)


def pdf_300p():
    path = target("pdf-300p.pdf")
    if not path:
        return
    n = 300
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>"]
    kids = " ".join(f"{3 + i * 2} 0 R" for i in range(n))
    objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {n} >>".encode())
    font_id = 3 + n * 2
    for i in range(n):
        content = (
            "BT /F1 12 Tf 50 750 Td 14 TL "
            + "".join(f"(Page {i + 1} ligne {j} lorem ipsum dolor sit amet) Tj T* " for j in range(45))
            + "ET"
        )
        objs.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents {4 + i * 2} 0 R "
            f"/Resources << /Font << /F1 {font_id} 0 R >> >> >>".encode()
        )
        c = content.encode()
        objs.append(b"<< /Length " + str(len(c)).encode() + b" >>\nstream\n" + c + b"\nendstream")
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    buf = bytearray(b"%PDF-1.4\n")
    offsets = []
    for idx, o in enumerate(objs, 1):
        offsets.append(len(buf))
        buf += f"{idx} 0 obj\n".encode() + o + b"\nendobj\n"
    xref = len(buf)
    buf += f"xref\n0 {len(objs) + 1}\n".encode() + b"0000000000 65535 f \n"
    for off in offsets:
        buf += f"{off:010d} 00000 n \n".encode()
    buf += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    with open(path, "wb") as f:
        f.write(buf)


def png_8000x6000():
    path = target("image-8000x6000.png")
    if not path:
        return
    w, h = 8000, 6000
    base = bytes((x * 255 // 256 + (x >> 3)) & 255 for x in range(w * 3 + 512))
    noise = rnd.randbytes(w * 3 + 512)
    comp = zlib.compressobj(1)
    idat = bytearray()
    for y in range(h):
        row = bytearray(base[(y % 251) : (y % 251) + w * 3])
        # un peu de bruit pour éviter une compression triviale
        row[::7] = noise[(y % 400) : (y % 400) + len(row[::7])]
        idat += comp.compress(b"\x00" + bytes(row))
    idat += comp.flush()

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)))
        f.write(chunk(b"IDAT", bytes(idat)))
        f.write(chunk(b"IEND", b""))


def zip_20000():
    path = target("zip-20000.zip")
    if not path:
        return
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for i in range(20000):
            z.writestr(f"dossier{i % 200}/sous{i % 17}/fichier-{i}.txt", f"contenu du fichier {i}\n" * 3)


def sqlite_1m():
    path = target("sqlite-1m.sqlite")
    if not path:
        return
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, price REAL, qty INTEGER, note TEXT)")
    db.execute("CREATE TABLE small (a INTEGER, b TEXT)")
    db.executemany("INSERT INTO small VALUES (?, ?)", [(i, f"v{i}") for i in range(10)])
    db.executemany(
        "INSERT INTO items VALUES (?, ?, ?, ?, ?)",
        ((i, f"nom {i}", i / 7, i % 100, f"note numéro {i}") for i in range(1_000_000)),
    )
    db.commit()
    db.close()


def xlsx_200k():
    path = target("xlsx-200k.xlsx")
    if not path:
        return
    rows = []
    for r in range(1, 200_001):
        rows.append(
            f'<row r="{r}"><c r="A{r}"><v>{r}</v></c><c r="B{r}" t="inlineStr"><is><t>texte {r}</t></is></c>'
            f'<c r="C{r}"><v>{r * 1.5}</v></c><c r="D{r}"><v>{r % 100}</v></c>'
            f'<c r="E{r}"><f>A{r}+D{r}</f><v>{r + r % 100}</v></c></row>'
        )
    sheet = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
        + "".join(rows)
        + "</sheetData></worksheet>"
    )
    ns = "http://schemas.openxmlformats.org/package/2006"
    od = "http://schemas.openxmlformats.org/officeDocument/2006"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(
            "[Content_Types].xml",
            f'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="{ns}/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        )
        z.writestr(
            "_rels/.rels",
            f'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="{ns}/relationships">'
            f'<Relationship Id="rId1" Type="{od}/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        )
        z.writestr(
            "xl/workbook.xml",
            '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            f'xmlns:r="{od}/relationships"><sheets><sheet name="Feuille1" sheetId="1" r:id="rId1"/></sheets></workbook>',
        )
        z.writestr(
            "xl/_rels/workbook.xml.rels",
            f'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="{ns}/relationships">'
            f'<Relationship Id="rId1" Type="{od}/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        )
        z.writestr("xl/worksheets/sheet1.xml", sheet)


for fn in (text_50mb, csv_50mb, json_20mb, binary_200mb, pdf_300p, png_8000x6000, zip_20000, sqlite_1m, xlsx_200k):
    fn()
