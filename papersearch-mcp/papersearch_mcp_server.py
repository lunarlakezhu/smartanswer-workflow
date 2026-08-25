#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
papersearch_mcp_server.py — SmartAnswer 检索后端（A 方案）· OpenAlex MCP 服务端 v3
stdio JSON-RPC 2.0 (MCP)，零第三方依赖（仅 Python 标准库）。

工具:
  search(query, limit=10, journal="", mailto="")
    - query:   英文检索词（OpenAlex 对中文支持弱，中文关键词须先翻译成英文）
    - limit:   最多返回条数（≤50）
    - journal: 可选平台/源过滤，取值:
        出版社(9): nature|springer|science|sciencedirect|ieee|pnas|sage|iop|wiley
        数据库/预印本(2): pubmed | arxiv
       （也接受域名写法 nature.com / arxiv.org / pubmed.ncbi.nlm.nih.gov 等，自动规范化）
    - mailto:  OpenAlex polite pool 邮箱

返回: JSON 数组，每条 {title, authors, year, doi, venue, citations, abstract, url, pmid}
      —— 全部来自 OpenAlex 真实元数据（含按 abstract_inverted_index 重建的真实摘要）
      —— pmid 仅 PubMed 收录文章非空

过滤表达式（2026-08-18 实测验证）:
  出版社: locations.source.host_organization_lineage:<P-id>
    nature/springer -> P4310319965 (Springer Nature, 两平台同属无法区分, 上游去重)
    science         -> P4310315823 (AAAS)
    sciencedirect   -> P4310320990 (Elsevier BV)
    ieee            -> P4310319808 (IEEE)
    pnas            -> P4310320052 (NAS)
    sage            -> P4310320017 (SAGE)
    iop             -> P4310320083 (IOP)
    wiley           -> P4310320595 (Wiley)
  pubmed: has_pmid:true                              (PubMed 收录索引, NCBI)
  arxiv:  primary_location.source.id:S4306400194    (arXiv, Cornell; 预印本, 320万篇)

v3.1 (2026-08-20 硬化, 对应 cordis.patch.yml toolCallTimeoutMs=180s):
  - _open_with_retry 最坏单请求 135s -> 110s (urlopen 20s + 退避封顶 10s),
    消除"server 还在 429 退避、客户端 60s 先超时"的连环 -32001
  - 额度耗尽型 429 (Retry-After > 120s) 立即报错不重试: OpenAlex 已切额度制,
    每日 1000 credits / search 一次 10 credits, 耗尽后重试纯属白等
  - 定位说明: pubmed 过滤是"文献来源补充"(OpenAlex has_pmid 面), 不是期刊;
    arxiv 过滤保留为通用能力, 但 SmartAnswer 检索路已删 (2026-08-20 用户裁决)

DSH 注册（profiles/web/cordis.patch.yml，serverName=papersearch）后，
模型工具名为 mcp__papersearch__search，由 search.js v4 的 args.searchTool 默认调用。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# Windows 下 stdio 管道默认用本地代码页（中文系统为 GBK/cp936），而 MCP stdio 协议
# 规定 UTF-8。作者名含 č/ś/ö 等非 GBK 字符时，ensure_ascii=False 的 JSON 写入会
# 触发 UnicodeEncodeError 使服务端崩溃（表现为 MCP error -32001）。此处强制重配置。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

DEFAULT_MAILTO = "your-mail@example.com"

# OpenAlex 免费个人 API key（2026-08-20 定价：注册后每日预算 $1，为匿名 $0.1 的 10 倍，
# 即关键词检索约 1000 次/天；注册 openalex.org → settings/api 复制）。
# 经 cordis.patch.yml 的 env.OPENALEX_API_KEY 注入；未配置时按匿名池计费，行为不变。
_API_KEY = os.environ.get("OPENALEX_API_KEY", "").strip()

# 平台/源标识 -> (OpenAlex 完整 filter 表达式, 显示名)
JOURNAL_FILTERS = {
    "nature":        ("locations.source.host_organization_lineage:P4310319965", "Springer Nature"),
    "springer":      ("locations.source.host_organization_lineage:P4310319965", "Springer Nature"),
    "science":       ("locations.source.host_organization_lineage:P4310315823", "AAAS (Science)"),
    "sciencedirect": ("locations.source.host_organization_lineage:P4310320990", "Elsevier BV"),
    "ieee":          ("locations.source.host_organization_lineage:P4310319808", "IEEE"),
    "pnas":          ("locations.source.host_organization_lineage:P4310320052", "National Academy of Sciences"),
    "sage":          ("locations.source.host_organization_lineage:P4310320017", "SAGE Publishing"),
    "iop":           ("locations.source.host_organization_lineage:P4310320083", "IOP Publishing"),
    "wiley":         ("locations.source.host_organization_lineage:P4310320595", "Wiley"),
    "pubmed":        ("has_pmid:true", "PubMed-indexed (NCBI)"),
    "arxiv":         ("primary_location.source.id:S4306400194", "arXiv (Cornell University)"),
}

# 常见别名（含站点域名）→ 平台标识
_JOURNAL_ALIASES = {
    "nature": "nature", "nature.com": "nature",
    "springer": "springer", "link.springer.com": "springer",
    "science": "science", "science.org": "science",
    "sciencedirect": "sciencedirect", "sciencedirect.com": "sciencedirect",
    "elsevier": "sciencedirect",
    "ieee": "ieee", "ieeexplore.ieee.org": "ieee",
    "pnas": "pnas", "pnas.org": "pnas",
    "sage": "sage", "journals.sagepub.com": "sage",
    "iop": "iop", "iopscience.iop.org": "iop",
    "wiley": "wiley", "onlinelibrary.wiley.com": "wiley",
    "pubmed": "pubmed", "pubmed.ncbi.nlm.nih.gov": "pubmed",
    "arxiv": "arxiv", "arxiv.org": "arxiv",
}

TOOLS = [
    {
        "name": "search",
        "description": (
            "Search real academic papers via OpenAlex (free, no API key). "
            "Returns JSON array of {title, authors, year, doi, venue, citations, abstract, url, pmid}. "
            "Optional journal filter: nature|springer|science|sciencedirect|ieee|pnas|sage|iop|wiley|pubmed|arxiv."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "keyword query (English recommended)"},
                "limit": {"type": "integer", "description": "max results (<=50)", "default": 10},
                "journal": {
                    "type": "string",
                    "description": "platform filter: nature|springer|science|sciencedirect|ieee|pnas|sage|iop|wiley|pubmed|arxiv",
                    "default": "",
                },
                "mailto": {"type": "string", "description": "OpenAlex polite pool email", "default": DEFAULT_MAILTO},
            },
            "required": ["query"],
        },
    }
]


def _norm_doi(doi):
    if not doi:
        return ""
    d = str(doi).strip().lower()
    for p in ("https://doi.org/", "http://doi.org/", "doi:"):
        d = d.replace(p, "")
    return d.strip()


def _rebuild_abstract(aii):
    """OpenAlex abstract_inverted_index {word: [positions]} → 顺序重建摘要文本"""
    if not aii:
        return ""
    pos = {}
    for word, ps in aii.items():
        for p in ps:
            pos[p] = word
    return " ".join(pos[i] for i in sorted(pos))


def _resolve_journal(journal):
    j = (journal or "").strip().lower()
    if not j:
        return None, None
    key = _JOURNAL_ALIASES.get(j)
    if key is None:  # 兜底：取域名首段再试（如 x.nature.com）
        key = _JOURNAL_ALIASES.get(j.split(".")[0])
    if key is None:
        return None, j
    filt, pname = JOURNAL_FILTERS[key]
    return filt, pname


# 进程内节流（2026-08-19 复盘：11 路子代理并发触发 OpenAlex 429）。匿名池约 10 req/s，
# 此处 ~8 req/s 留余量；多 server 进程并存时不能完全消除 429，由 _open_with_retry 兜底。
_MIN_INTERVAL = 0.12
_last_call = [0.0]

# OpenAlex 已切换额度制（2026-08-20 实测响应头 X-RateLimit-*）：每日 1000 credits、
# search 一次 10 credits，耗尽后 429 且 Retry-After 为小时级（当日重置）。这种 429
# 重试无意义：立即报错让调用方止损（检索子代理按"同一错误 2 次即停"处理）。
_QUOTA_EXHAUSTED_RETRY_AFTER_S = 120.0

def _throttle():
    dt = time.monotonic() - _last_call[0]
    if dt < _MIN_INTERVAL:
        time.sleep(_MIN_INTERVAL - dt)
    _last_call[0] = time.monotonic()

def _open_with_retry(req, timeout=20, max_retry=3):
    """urlopen 包装：429 按 Retry-After（缺省 1s/2s/4s 指数退避，单次封顶 10s）重试至多 max_retry 次。

    429 是瞬时限流，不应把已成功的整路检索变成失败（复盘教训）。其余错误原样抛出。
    Retry-After 超过 _QUOTA_EXHAUSTED_RETRY_AFTER_S 视为当日额度耗尽：立即抛 RuntimeError
    （带剩余秒数）——重试只会白等，还会拖垮串行队列里的其他请求。
    最坏单请求 = 4 次 urlopen(20s) + 3 次等待(10s) = 110s：必须保持低于客户端
    toolCallTimeoutMs（cordis.patch.yml 现 180s）。旧参数（25s + 30s 封顶）最坏 135s，
    2026-08-20 实测 11 路并发触发 429 退避时单请求拖过 60s 客户端上限，连环 -32001。
    """
    for attempt in range(max_retry + 1):
        _throttle()
        try:
            return urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < max_retry:
                wait = e.headers.get("Retry-After") if e.headers else None
                try:
                    delay = float(wait) if wait is not None else 2 ** attempt
                except ValueError:
                    delay = 2 ** attempt
                if delay > _QUOTA_EXHAUSTED_RETRY_AFTER_S:
                    raise RuntimeError(
                        "OpenAlex daily credit quota exhausted (search costs 10 of 1000 credits/day), "
                        "resets in %ds — stop searching this route, do not retry" % int(delay)
                    ) from e
                time.sleep(min(delay, 10.0))
                continue
            raise
    raise RuntimeError("unreachable: retry loop exhausted")

def search_openalex(query, limit, journal, mailto):
    filt, _pname = _resolve_journal(journal)
    if journal and filt is None:
        raise ValueError(
            "unknown journal %r; supported: %s" % (journal, "|".join(sorted(set(JOURNAL_FILTERS))))
        )
    params = {
        "search": query,
        "per-page": min(int(limit), 50),
        "mailto": mailto or DEFAULT_MAILTO,
    }
    if _API_KEY:
        params["api_key"] = _API_KEY
    if filt:
        params["filter"] = filt
    url = "https://api.openalex.org/works?" + urllib.parse.urlencode(params, safe=":")
    req = urllib.request.Request(url, headers={"User-Agent": "papersearch-mcp/3.0"})
    with _open_with_retry(req) as r:
        data = json.loads(r.read().decode("utf-8"))
    out = []
    for w in data.get("results", []):
        authors = [a.get("author", {}).get("display_name", "") for a in w.get("authorships", [])][:5]
        src = (w.get("primary_location") or {}).get("source") or {}
        doi_n = _norm_doi(w.get("doi"))
        pmid = (w.get("ids") or {}).get("pmid", "") or ""
        out.append({
            "title": (w.get("title") or "").strip(),
            "authors": ", ".join(a for a in authors if a),
            "year": w.get("publication_year") or "",
            "doi": doi_n,
            "venue": src.get("display_name", "") or "",
            "citations": w.get("cited_by_count", 0) or 0,
            "abstract": _rebuild_abstract(w.get("abstract_inverted_index"))[:1200],
            "url": ("https://doi.org/" + doi_n) if doi_n else (w.get("id") or ""),
            "pmid": pmid,
        })
    return out


def handle(msg):
    method = msg.get("method")
    mid = msg.get("id")
    if method == "initialize":
        return {
            "jsonrpc": "2.0", "id": mid,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "papersearch-mcp", "version": "3.0"},
            },
        }
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}}
    if method == "tools/call":
        name = msg.get("params", {}).get("name")
        a = msg.get("params", {}).get("arguments", {}) or {}
        if name == "search":
            try:
                rows = search_openalex(a.get("query", ""), a.get("limit", 10), a.get("journal", ""), a.get("mailto", ""))
                return {"jsonrpc": "2.0", "id": mid,
                        "result": {"content": [{"type": "text", "text": json.dumps(rows, ensure_ascii=False)}]}}
            except Exception as e:
                return {"jsonrpc": "2.0", "id": mid,
                        "result": {"content": [{"type": "text", "text": json.dumps({"error": str(e)}, ensure_ascii=False)}],
                                   "isError": True}}
    return None


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        m = msg.get("method")
        if m == "notifications/initialized":
            continue
        if m == "ping":
            if "id" in msg:
                sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}) + "\n")
                sys.stdout.flush()
            continue
        resp = handle(msg)
        if resp:
            sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
