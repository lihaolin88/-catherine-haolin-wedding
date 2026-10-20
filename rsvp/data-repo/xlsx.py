"""Turn RSVP responses (a list of dicts) into a formatted Excel workbook.

Sheet "RSVP" has a filter dropdown on every column header (tap First Course /
Main Course to see who chose a dish); sheet "By Dish" lists names per dish.
"""
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill

# (key in the submitted JSON, column header in the sheet, column width)
COLUMNS = [
    ("name", "Name", 18),
    ("firstCourse", "First Course", 30),
    ("mainCourse", "Main Course", 30),
    ("arrival", "Arrival in Hawaii", 16),
    ("allergies", "Allergies", 24),
    ("drinks", "Alcohol / Wine", 24),
    ("notes", "Anything We Should Know", 36),
    ("wishes", "Blessings", 48),
    ("submittedAt", "Last Updated (UTC)", 20),
    ("firstSubmittedAt", "First Submitted (UTC)", 20),
    ("lang", "Lang", 6),
]

COURSES = (("firstCourse", "First Course"), ("mainCourse", "Main Course"))


def write_xlsx(rows, path):
    wb = Workbook()
    ws = wb.active
    ws.title = "RSVP"
    ws.append([header for _, header, _ in COLUMNS])
    for row in rows:
        ws.append([row.get(key, "") for key, _, _ in COLUMNS])

    header_fill = PatternFill("solid", fgColor="A3823A")
    for cell in ws[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = header_fill
        cell.alignment = Alignment(vertical="center")
    for i, (_, _, width) in enumerate(COLUMNS, start=1):
        ws.column_dimensions[ws.cell(1, i).column_letter].width = width
    for row in ws.iter_rows(min_row=2):
        for cell in row:
            cell.alignment = Alignment(wrap_text=True, vertical="top")
    ws.freeze_panes = "B2"
    ws.auto_filter.ref = ws.dimensions

    # Who picked what: one block per dish with the count and every guest's name.
    by_dish = wb.create_sheet("By Dish")
    by_dish.column_dimensions["A"].width = 38
    by_dish.column_dimensions["B"].width = 22
    for key, label in COURSES:
        groups = {}
        for row in rows:
            groups.setdefault(row.get(key) or "(none)", []).append(row.get("name", ""))
        by_dish.append([label.upper()])
        by_dish.cell(by_dish.max_row, 1).font = Font(bold=True, color="FFFFFF")
        by_dish.cell(by_dish.max_row, 1).fill = header_fill
        by_dish.cell(by_dish.max_row, 2).fill = header_fill
        for choice, names in sorted(groups.items()):
            by_dish.append([f"{choice} ({len(names)})"])
            by_dish.cell(by_dish.max_row, 1).font = Font(bold=True, color="7C5E28")
            for name in names:
                by_dish.append(["", name])
        by_dish.append([])
    by_dish.append(["Total responses", len(rows)])
    by_dish.cell(by_dish.max_row, 1).font = Font(bold=True)

    wb.save(path)
