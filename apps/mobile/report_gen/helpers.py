"""Shared helpers for building the retest report DOCX."""
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import nsdecls
from docx.oxml import parse_xml

DARK = '1A1A2E'
TEAL = '3FC6B8'
LIGHT = 'E8EAF6'


def set_cell_shading(cell, color_hex):
    shading = parse_xml(f'<w:shd {nsdecls("w")} w:fill="{color_hex}"/>')
    cell._tc.get_or_add_tcPr().append(shading)


def set_cell_text(cell, text, bold=False, font_size=9.5, align=None, color=None):
    p = cell.paragraphs[0]
    if align is not None:
        p.alignment = align
    run = p.add_run(text)
    run.bold = bold
    run.font.size = Pt(font_size)
    run.font.name = 'Calibri'
    if color is not None:
        run.font.color.rgb = color
    return run


def status_cell(cell, status):
    """PASS (green), FAIL (red), NOT RETESTED (orange), REQUIRES DEVICE TEST (yellow)."""
    colors = {
        'PASS': ('2E7D32', 'E8F5E9'),
        'FAIL': ('C62828', 'FFEBEE'),
        'NOT RETESTED': ('E65100', 'FFF3E0'),
        'REQUIRES DEVICE TEST': ('8A6D00', 'FFF8E1'),
        'CODE VERIFIED': ('1565C0', 'E3F2FD'),
        'DEVICE TESTED': ('2E7D32', 'E8F5E9'),
    }
    fg, bg = colors.get(status, ('000000', 'FFFFFF'))
    set_cell_shading(cell, bg)
    p = cell.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(status)
    run.bold = True
    run.font.size = Pt(8.5)
    run.font.name = 'Calibri'
    rgb = RGBColor(int(fg[0:2], 16), int(fg[2:4], 16), int(fg[4:6], 16))
    run.font.color.rgb = rgb


def header_row(table, labels, font_size=9.5):
    for j, h in enumerate(labels):
        set_cell_shading(table.rows[0].cells[j], DARK)
        set_cell_text(table.rows[0].cells[j], h, bold=True, font_size=font_size,
                      align=WD_ALIGN_PARAGRAPH.CENTER, color=RGBColor(0xFF, 0xFF, 0xFF))


def h(doc, text, level=1):
    heading = doc.add_heading(text, level=level)
    for r in heading.runs:
        r.font.color.rgb = RGBColor(0x1A, 0x1A, 0x2E)
    return heading


def body(doc, text, bold=False, size=10.5):
    p = doc.add_paragraph()
    run = p.add_run(text)
    run.bold = bold
    run.font.size = Pt(size)
    run.font.name = 'Calibri'
    return p


def kv(doc, label, text, size=10):
    p = doc.add_paragraph()
    r1 = p.add_run(label + ' ')
    r1.bold = True
    r1.font.size = Pt(size)
    r1.font.name = 'Calibri'
    r2 = p.add_run(text)
    r2.font.size = Pt(size)
    r2.font.name = 'Calibri'
    return p


def data_table(doc, rows, cols):
    t = doc.add_table(rows=rows, cols=cols)
    t.style = 'Table Grid'
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    return t