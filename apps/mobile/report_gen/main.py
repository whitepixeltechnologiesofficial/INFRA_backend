"""Main: build ONB-1.1-V Team Alpha Retest Report DOCX."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from docx import Document
from docx.shared import Pt, Cm
from docx.enum.section import WD_ORIENT
from docx.enum.text import WD_ALIGN_PARAGRAPH

import part1, part2, part3, part4

SUMMARY = {
    'pass': 6,
    'fail': 0,
    'not_retested': 0,
    'device': 6,
}

doc = Document()

# Landscape orientation for the wide retest tables
sec = doc.sections[0]
sec.orientation = WD_ORIENT.LANDSCAPE
new_w, new_h = sec.page_height, sec.page_width
sec.page_width, sec.page_height = new_w, new_h
sec.top_margin = Cm(1.8)
sec.bottom_margin = Cm(1.8)
sec.left_margin = Cm(1.8)
sec.right_margin = Cm(1.8)

normal = doc.styles['Normal']
normal.font.name = 'Calibri'
normal.font.size = Pt(10.5)

part1.build(doc, {})
part2.build(doc)
part3.build(doc)
part4.build(doc, SUMMARY)

out = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   'ONB-1.1-V_Team_Alpha_Retest_Report.docx')
doc.save(out)
print('Saved:', out)