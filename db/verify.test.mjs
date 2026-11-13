import { expect, test } from 'bun:test';
import { auditDraft, citationUrl } from './verify.mjs';

test('audits exact source opens, locator and reported origin groups before editorial review', () => {
  const draft = {
    claims: [{
      id: 'C001', verdict: 'Supported', counterevidence: 'The competing record is older.',
      citations: [
        { sourceId: 'S001', relation: 'supporting', locator: 'Page 4' },
        { sourceId: 'S002', relation: 'supporting', locator: 'Page 4' },
        { sourceId: 'S003', relation: 'context', locator: ' ' },
      ],
    }],
    sources: [
      { id: 'S001', url: 'https://records.example/a?id=2#page=4', access: 'inspected', originGroup: 'Record' },
      { id: 'S002', url: 'https://records.example/mirror', access: 'inspected', originGroup: 'record' },
      { id: 'S003', url: 'https://records.example/b', access: 'inspected', originGroup: 'Other' },
    ],
  };
  const audit = auditDraft(draft, [
    citationUrl('https://records.example/a?id=2'),
    citationUrl('https://records.example/mirror'),
    citationUrl('https://records.example/other'),
  ]);
  expect(audit).toMatchObject({
    status: 'source_checks_needed',
    findings: [{
      openedSourceIds: ['S001', 'S002'], reportedOriginGroups: ['record'],
      issues: ['review_source_independence_or_controlling_record'],
      flaggedCitations: [{ sourceId: 'S003', issues: ['missing_locator', 'source_open_unconfirmed'] }],
    }],
  });
});
