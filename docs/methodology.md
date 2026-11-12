# Review methodology

**Fact-checking methodology.** We used GPT‑6.1 in ChatGPT with the open-source [Investigate & Fact-Check skill](https://github.com/KhademOHAli1/investigate-and-fact-check) to identify checkable claims, trace them to original sources, and flag where the evidence was incomplete or conflicting.

The review covers the submitted video and the evidence inspected through November 12, 2026. The video's original publication, recording date, and narrator identity remain unverified. The transcript uses a corrected automated transcription compared with a separate recognition pass. Timing is approximate and a complete listening review remains outstanding.

## From statement to finding

1. Locate the statement in the transcript and identify the proposition that the evidence can test. Record qualifications, time references, and implied scope. Split statements when their parts require separate evidence.
2. Prefer direct records and original research where available. Record the source, date or version, pinpoint, what it establishes, and what remains unknown. Treat articles that rely on the same underlying record or statement as one evidence stream.
3. Compare supporting and contrary evidence. An inquiry establishes an inquiry, and a filing establishes what was declared. The underlying allegation or declaration requires its own verification.
4. Record the verdict, its scope, confidence, evidence, counterevidence, and the next check that could change the assessment. The [public claim ledger](../src/data/case.json) and [source register](../evidence/registry.json) retain those details.

## Verdicts

| Verdict | Meaning |
| --- | --- |
| Supported | The evidence supports the claim within the stated scope. |
| Contradicted | The evidence conflicts with the claim within the stated scope. |
| Misleading | The wording or omitted context gives a materially inaccurate impression. |
| Mixed | The claim contains elements with different evidentiary outcomes. |
| Unsubstantiated | The inspected evidence does not adequately support the claim. |
| Unresolved | A material conflict or evidence gap prevents a determination. |
| Not fact-checkable | The statement is opinion, rhetoric, a prediction, or too vague to test as framed. |

Confidence describes the assessment within its stated scope. Unproven does not mean false. The 47 entries overlap, so verdict counts do not measure the percentage of the video that is true. Some records were inaccessible, and a human editorial review and legal review remain outstanding. The review considered public responses where located. No reply request was sent.

## Evidence and corrections

Original source links are the primary citations. The repository preserves versioned copies of selected public documents, labeled excerpts, and citation records for other material. Hashes identify the stored file versions. See [evidence retention and limits](../evidence/README.md).

Source records link to cited passages, sections, and PDF pages where a jump is available. Text highlights depend on the browser and the wording on the publisher's page. Use the **Where to look** reference if a jump opens at the start of the source.

Use [the public correction form](https://github.com/KhademOHAli1/claim-by-claim/issues/new?template=correction.yml) to identify an affected entry, propose a change, and provide public evidence. For a confirmed correction, update the relevant transcript, assessment, or source record and link the issue in the change so readers can trace it.
