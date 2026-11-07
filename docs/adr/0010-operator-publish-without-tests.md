# ADR 0010: An operator may publish a version without a passed gate run

- Status: Accepted
- Date: 2026-11-07
- Task: operator publish override
- Changes: the locked M5-4 decision "a chatbot version goes live only Draft → Testing → Ready (its Gate run's Done finish) → Published" (CLAUDE.md › Runtime › Publish gate, and the hard ban on publishing a version that isn't Ready on a passed gate run). A Diletta operator may now publish a Testing or Ready version without that run.

## Context

The gate needs a working hosted eval runner and a Test sign-in on the company's Staging connection (ADR 0007). Until both are in place, or while a run keeps failing for reasons outside the version (a flaky host, a case that needs fixing), a company has no way to put a version live, and an operator supporting it (ADR 0006) can't help even when they have checked the version by hand. A bot stuck at Testing with "Not tested" is the case that prompted this.

## Decision

1. **A separate, operator-only action.** `POST /dashboard/chatbots/:chatbotPublicId/configs/:publicId/publish-without-tests`, authorized by `AuthzActionEnum.ChatbotConfigPublishOverride`, which is in `OPERATOR_ONLY_ACTIONS`. A company admin gets 403. The normal `/publish` is unchanged and stays strict: the override is not a flag on it, so no request body can switch the gate off.
2. **Which versions.** Testing or Ready. A Draft is refused (409 `NotInGate`): it must be sent to testing first, so its body and needs were checked once before it was tested.
3. **What is skipped.** The approval of a passed Gate run (`checkGateApproval`), which includes the check that every active safety case ran. Nothing else: the version's needs (an Active model key for each provider, priced models, Active pinned tools) are checked under the same locks, the old Published version is archived, and the publish is one transaction.
4. **It is recorded.** The audit row is `PublishedWithoutTests` ("Published a version without its tests passing"), made by the operator (ADR 0006), so the company's audit log shows it. `approved_by_run_id` is left as it is (null for a version that never passed).
5. **A gate run in flight is harmless.** A Gate run's finish moves a version only while it is Testing (`applyGateResult`); a published version is not, so the late finish changes nothing.
6. **Web.** On a Testing or Ready version an operator sees "Publish without tests" beside the other actions, behind a confirmation that says the tests and safety cases are skipped and the publish is recorded. A company admin never sees it.

## Consequences

- The safety hard gate is no longer absolute: an operator can put a version live with a failed safety case. The protection is accountability (an operator-only action and an audit row), the same trade as ADR 0006. Operators are still added by hand only.
- The hard ban becomes "publishing a version that isn't Ready on a passed gate run, other than through `publishChatbotConfigWithoutTests`".
- The DAL's `publishChatbotConfig` takes the statuses it may publish from; the strict path passes Ready only.
- Nightly and Manual runs, the gate run itself and the Ready move are unchanged.
