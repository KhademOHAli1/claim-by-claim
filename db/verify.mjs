export function citationUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

// A completed open event links a citation to a tool action. Only an editor can
// establish what the page actually says, its relevance, and its independence.
export function auditDraft(draft, openedUrls) {
  const opened = new Set(openedUrls);
  const sources = new Map(draft.sources.map((source) => [source.id, source]));
  const findings = draft.claims.map((claim) => {
    const openedSources = new Set();
    const reportedOrigins = new Set();
    const flaggedCitations = [];
    const relevantRelation = { Supported: 'supporting', Contradicted: 'contradicting' }[claim.verdict];
    for (const citation of claim.citations) {
      const source = sources.get(citation.sourceId);
      const url = citationUrl(source.url);
      const issues = [];
      if (!citation.locator.trim()) issues.push('missing_locator');
      if (source.access === 'inspected' && (!url || !opened.has(url))) issues.push('source_open_unconfirmed');
      if (issues.length) flaggedCitations.push({ sourceId: source.id, issues });
      if (source.access === 'inspected' && !issues.length &&
          (!relevantRelation || citation.relation === relevantRelation)) {
        openedSources.add(source.id);
        if (source.originGroup.trim()) reportedOrigins.add(source.originGroup.trim().toLowerCase());
      }
    }
    const issues = [];
    if (['Supported', 'Contradicted', 'Misleading', 'Mixed'].includes(claim.verdict)) {
      if (!openedSources.size) issues.push('decisive_source_open_unconfirmed');
      if (reportedOrigins.size < 2) issues.push('review_source_independence_or_controlling_record');
      if (!claim.counterevidence.trim()) issues.push('missing_counterevidence_or_search_limit');
    }
    return {
      claimId: claim.id, openedSourceIds: [...openedSources], reportedOriginGroups: [...reportedOrigins],
      issues, flaggedCitations,
    };
  });
  return {
    method: 'citation-audit-v1',
    status: findings.some(({ issues, flaggedCitations }) => issues.length || flaggedCitations.length)
      ? 'source_checks_needed' : 'awaiting_editor',
    findings,
  };
}
