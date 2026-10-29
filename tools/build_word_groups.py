# -*- coding: utf-8 -*-
"""把「单词筛选」里的近义词表 / 形近词表转成前端可用的词群数据。

源文件放在 tools/word_groups/ 下（从桌面「单词筛选」复制而来）：
- 近义词表.xlsx   工作表：近义词组
- 形近词表.xlsx   工作表：易混词、同词根派生

输出：site/vocab/data/word_groups.json

改分组请改 xlsx，然后重新运行：
    python tools/build_word_groups.py
"""
import json
import os
import sys
from collections import OrderedDict

import openpyxl

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(ROOT, "tools", "word_groups")
SYN_XLSX = os.path.join(SRC_DIR, "近义词表.xlsx")
CNF_XLSX = os.path.join(SRC_DIR, "形近词表.xlsx")
OUT_FILE = os.path.join(ROOT, "site", "vocab", "data", "word_groups.json")


def clean_text(v):
    return " ".join(str(v or "").split())


def as_int(v):
    try:
        return int(float(str(v).strip()))
    except (TypeError, ValueError):
        return 0


def read_groups(path, sheet, kind):
    """按组号聚合行。返回按首次出现顺序排列的组列表。"""
    if not os.path.isfile(path):
        print("找不到源文件：%s" % path)
        print("请把「近义词表.xlsx」「形近词表.xlsx」放到 %s" % SRC_DIR)
        sys.exit(1)

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb[sheet]
    rows = ws.iter_rows(values_only=True)
    next(rows)  # 表头

    groups = OrderedDict()
    for r in rows:
        if r is None or r[0] is None:
            continue
        group_no = str(r[0]).strip()
        word = clean_text(r[3]) if kind == "syn" else clean_text(r[1])
        if not word:
            continue
        defn = clean_text(r[4]) if kind == "syn" else clean_text(r[2])
        freq = as_int(r[5] if kind == "syn" else r[3])

        if group_no not in groups:
            if kind == "syn":
                groups[group_no] = {
                    "name": clean_text(r[2]),
                    "pos": clean_text(r[1]),
                    "words": [],
                }
            else:
                groups[group_no] = {
                    "name": clean_text(r[4]),
                    "pos": "",
                    "words": [],
                }
        groups[group_no]["words"].append({
            "word": word,
            "display": word,
            "freq": freq,
            "definition": defn,
        })
    wb.close()

    out = []
    for idx, (group_no, g) in enumerate(groups.items()):
        g["id"] = "%s-%d" % (kind, idx)
        g["maxFreq"] = max(w["freq"] for w in g["words"])
        g["wordCount"] = len(g["words"])
        out.append(g)
    return out


def main():
    syn = read_groups(SYN_XLSX, "近义词组", "syn")
    cnf = read_groups(CNF_XLSX, "易混词", "cnf")
    fam = read_groups(CNF_XLSX, "同词根派生", "fam")

    errors = []
    for kind, groups in [("syn", syn), ("cnf", cnf), ("fam", fam)]:
        for g in groups:
            if not (2 <= g["wordCount"] <= 6):
                errors.append("%s 组大小异常：%s（%d 词）" % (kind, g["id"], g["wordCount"]))
            if g["maxFreq"] < 0:
                errors.append("%s 词频异常：%s" % (kind, g["id"]))

    if errors:
        print("发现 %d 个问题：" % len(errors))
        for e in errors[:20]:
            print(" -", e)
        sys.exit(1)

    data = {
        "version": 3,
        "source": "tools/word_groups/近义词表.xlsx + 形近词表.xlsx",
        "types": {
            "syn": {"label": "近义词组", "short": "近义", "groups": syn},
            "cnf": {"label": "易混词", "short": "易混", "groups": cnf},
            "fam": {"label": "同词根派生", "short": "同根", "groups": fam},
        },
    }

    with open(OUT_FILE, "w", encoding="utf-8") as fp:
        json.dump(data, fp, ensure_ascii=False, separators=(",", ":"))

    print("已生成 %s" % OUT_FILE)
    print("近义词组 %d 组，易混词 %d 组，同词根派生 %d 组，共 %d 组" %
          (len(syn), len(cnf), len(fam), len(syn) + len(cnf) + len(fam)))
    print("涉及单词 %d 个" %
          len({w["word"] for groups in (syn, cnf, fam) for g in groups for w in g["words"]}))
    print("文件大小 %.1f KB" % (os.path.getsize(OUT_FILE) / 1024))


if __name__ == "__main__":
    main()
