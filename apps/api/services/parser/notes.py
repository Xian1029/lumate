"""AI Notes restructuring service.

Takes content tree nodes and restructures them based on user preferences.
Supports formats: bullet_point, table, mind_map, step_by_step, summary.

Phase 0-B: LLM-based restructuring with Mermaid/KaTeX output.
Reference: textbook_quality project for content generation pipeline.
"""

from services.llm.router import get_llm_client
import re
import unicodedata


_CONTROL_CHARACTERS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_MOJIBAKE_MARKERS = re.compile(r"(?:Ã.|Â.|â..|[\u00c2-\u00f4][\u0080-\u00bf])")


def normalize_generated_markdown(value: str | None) -> str:
    """Return safe, readable Markdown from any AI-note write/read path.

    This is deliberately content-preserving: it repairs recognizable broken
    UTF-8, strips invisible transport characters and normalizes newlines, but
    never tries to rewrite a learner's mathematical or multilingual content.
    """
    cleaned = (value or "").replace("\r\n", "\n").replace("\r", "\n")
    cleaned = _CONTROL_CHARACTERS.sub("", cleaned).replace("\ufffd", "")
    # Remove invisible transport marks before attempting a byte-level repair:
    # a BOM inserted mid-string otherwise makes the entire repair fail.
    cleaned = "".join(
        char for char in cleaned
        # U+00AD may be a real byte in mojibake (for example the third byte
        # of UTF-8 for a Chinese character), so preserve it until repair.
        if unicodedata.category(char) != "Cf" or char in {"\n", "\t", "\u00ad"}
    )
    if _MOJIBAKE_MARKERS.search(cleaned):
        # Handle both Latin-1 and Windows-1252 mojibake produced by copied or
        # streamed UTF-8 content. If the conversion is not lossless, preserve
        # the original text instead of damaging legitimate multilingual notes.
        for encoding in ("latin-1", "cp1252"):
            try:
                repaired = cleaned.encode(encoding).decode("utf-8")
            except (UnicodeEncodeError, UnicodeDecodeError):
                continue
            # Only accept a repair when it actually removes the recognizable
            # broken-encoding marker.  This prevents a false positive from
            # corrupting valid Chinese, formula, or Markdown text.
            if _MOJIBAKE_MARKERS.search(repaired) is None:
                cleaned = repaired
            break
    # Zero-width/BOM formatting controls are not visible to a student and can
    # split Markdown tokens or Mermaid labels. Keep ordinary Unicode letters,
    # maths symbols and punctuation intact.
    cleaned = "".join(
        char for char in cleaned
        if unicodedata.category(char) != "Cf" or char in {"\n", "\t"}
    )
    return unicodedata.normalize("NFC", cleaned).strip()

# Format-specific system prompts for note restructuring
FORMAT_PROMPTS = {
    "bullet_point": """Restructure the following content into clear, hierarchical bullet points.
Use markdown formatting:
- Main points as top-level bullets
- Sub-points indented with proper hierarchy
- Bold key terms
- Keep it concise but comprehensive""",

    "table": """Restructure the following content into markdown tables where appropriate.
- Use tables for comparisons, definitions, properties, or any structured data
- Include a brief intro paragraph before each table
- Bold headers and key terms""",

    "mind_map": """Restructure the following content as a Mermaid.js mind map diagram.
Output valid Mermaid mindmap syntax that can be rendered.
Example format:
```mermaid
mindmap
  root((Topic))
    Branch 1
      Sub-point
      Sub-point
    Branch 2
      Sub-point
```
Requirements:
- Use the section title as the root topic
- Include at least two meaningful branches and one supporting point per branch when the source permits
- If the source is too short to form a useful map, use a concise bullet summary instead of an empty diagram
Also include a brief text summary after the diagram.""",

    "step_by_step": """Restructure the following content as numbered steps or a process flow.
- Number each step clearly
- Include prerequisites if any
- Use arrows (→) to show flow/dependencies
- For complex processes, include a Mermaid flowchart:
```mermaid
graph TD
    A[Step 1] --> B[Step 2]
```""",

    "summary": """Create a concise summary of the following content.
- Start with a one-sentence overview
- List 3-5 key takeaways
- Include any important formulas using KaTeX: $formula$
- End with connections to other concepts if applicable""",
}

VISUAL_PROMPT = """You are an expert at choosing the best visual representation for educational content.
When the content includes:
- Processes/workflows → use Mermaid flowchart (graph TD)
- Comparisons → use markdown tables
- Hierarchies/taxonomies → use Mermaid mindmap
- Mathematical formulas → use KaTeX ($...$) or ($$...$$)
- Relationships → prefer concise bullets or a simple markdown table

Mermaid rules:
- Prefer only Mermaid mindmap or graph TD for notes
- Keep Mermaid node labels short and plain-text only
- Do not put code snippets, JSON, braces, quotes, markdown formatting, or long examples inside Mermaid nodes
- Put concrete examples and detailed explanations in normal markdown below the diagram

Always output valid Mermaid syntax wrapped in ```mermaid blocks.
Always output valid KaTeX wrapped in $ or $$ delimiters."""

CHILD_FRIENDLY_WRITING_PROMPT = """Write notes that a child can read independently.

Use the same language as the source material. Make the explanation coherent, not
a pile of extracted sentences. Follow this teaching order whenever the source
contains enough information:
1. Start with a one- or two-sentence "What are we learning?" overview.
2. Explain the central idea in plain words before using specialist terms.
3. Build the explanation in a small number of ordered sections. Each section
   must naturally lead to the next with a short transition such as "Now that we
   know..., let's see...".
4. Define a new term the first time it appears, using a short child-friendly
   explanation in parentheses or after a dash.
5. Include one concrete, everyday example only when it is supported by the
   source; label it clearly as an example.
6. End with a short "Remember" recap of 3-5 points and, when appropriate, one
   simple self-check question. Do not provide a misleading answer if the source
   does not contain enough information.

Quality rules:
- Prefer short paragraphs, clear headings, and complete sentences over dense
  fragments or long unconnected bullet lists.
- Keep one idea per bullet. Explain cause-and-effect and sequence explicitly.
- Do not use unexplained abbreviations, jargon, adult-only analogies, or a
  patronizing tone.
- Preserve facts, uncertainty, and terminology from the source. Never invent
  facts, examples, dates, or conclusions to make the note sound smoother.
- A diagram supports the explanation; it must never replace the written
  explanation."""


async def restructure_notes(
    content: str,
    title: str,
    note_format: str = "bullet_point",
    visual_preference: str = "auto",
) -> str:
    """Restructure content based on user preference format.

    Args:
        content: Raw content text from content tree node
        title: Section title for context
        note_format: One of bullet_point, table, mind_map, step_by_step, summary
        visual_preference: "auto" lets AI decide, or specify mermaid/katex/table/none

    Returns:
        Restructured content as markdown string (may include Mermaid/KaTeX)
    """
    format_prompt = FORMAT_PROMPTS.get(note_format, FORMAT_PROMPTS["bullet_point"])

    system_prompt = f"""You are OpenTutor, an AI study assistant that restructures learning materials.

{format_prompt}

{VISUAL_PROMPT if visual_preference == "auto" else ""}

{CHILD_FRIENDLY_WRITING_PROMPT}

Important:
- Preserve all important information from the original
- Use proper markdown formatting
- Include Mermaid diagrams and KaTeX formulas where they add value
- Keep Mermaid labels simple and diagram-safe; move detailed examples into bullets below the diagram
- Do NOT add information not present in the original content"""

    user_message = f"## {title}\n\n{content}"

    client = get_llm_client()
    result, _ = await client.chat(system_prompt, user_message)
    return normalize_generated_markdown(result)


async def restructure_content_tree(
    nodes: list[dict],
    note_format: str = "bullet_point",
    visual_preference: str = "auto",
) -> list[dict]:
    """Restructure all content tree nodes.

    Args:
        nodes: List of content tree node dicts with 'title' and 'content'
        note_format: User's preferred format
        visual_preference: Visual rendering preference

    Returns:
        Same nodes with 'ai_content' field added
    """
    results = []
    for node in nodes:
        if node.get("content"):
            ai_content = await restructure_notes(
                node["content"],
                node["title"],
                note_format,
                visual_preference,
            )
            results.append({**node, "ai_content": ai_content})
        else:
            results.append(node)
    return results
