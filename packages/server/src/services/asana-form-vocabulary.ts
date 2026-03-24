/**
 * Asana form "Duplicate of Events 2.0" vocabulary.
 * Used to guide the AI classifier to produce labels matching paralegal naming conventions.
 */

export function buildDocumentLabelGuidance(): string {
  return `
DOCUMENT LABEL FORMAT GUIDE (match paralegal naming conventions):

The task title is built as "{documentLabel}, {date}" so documentLabel should be ONLY the document type — no dates, no client names.

FOR "Received" DOCUMENTS:
- USCIS notices: "{Form Number}, {Notice Type}"
  Forms: I-90, I-102, I-192, I-129, I-130, I-131, I-212, I-290B, I-360, I-485, I-539, I-589,
         I-601, I-601A, I-751, I-765, I-821, I-821D, I-912, I-918, I-918 Supp A, I-918 Supp B,
         N-336, N-400, N-600, EOIR 42A (fee in), EOIR 42B (fee-in)
  Notice types: Receipt Notice, Approval Notice, Denial Notice, RFE, NOID, Transfer Notice,
    Change of Address Confirmation, Biometrics Notice, Interview Notice,
    Bona Fide Determination Notice, Prima Facie Determination Notice,
    Naturalization Oath Ceremony Notice, Deferred Action Notice,
    ASC notice of fee receipt and biometrics appointment
  Examples: "I-130, Receipt Notice" or "I-485, Approval Notice" or "N-400, Interview Notice"

- NVC notices (use exact label):
  Notice of Immigrant Visa Case Creation, DS-260 Filing Confirmation Notice,
  DS-160 Filing Confirmation Notice, Case Documentarily Qualified,
  Immigrant Visa Interview Appointment, ASC Appointment Notice,
  NVC Request for Evidence, IV Fee Receipt (in process), IV Fee Receipt (paid),
  Affidavit of Support Fee Receipt (in process), Affidavit of Support Fee Receipt (paid)

- DOS/Consular notices: Visa Refusal Notice, Immigrant Visa Appointment Notice,
  Fingerprint Appointment Notice, DS-11 Receipt, DS-11 RFE, DS-11 Denial, DS-11 Approval

- Immigration Court: Master Calendar Hearing Notice, Individual Hearing Notice,
  Cancellation of Hearing Notice, IJ Order, IJ Decision, IJ Scheduling Order

- ICE/DHS: NTA, I-213, Expedited Removal Order, Credible Fear Interview Work Sheet,
  DHS Motion to Dismiss, DHS Motion to Pretermit, DHS Motion to Continue,
  DHS Exhibits, DHS Brief

- BIA: BIA Decision, BIA Briefing Schedule, BIA Transcript/IJ Written Decision, BIA Notice

- Physical Items: Green Card, Social Security Card, EAD Card

- FOIA Responses: "{Agency} FOIA Response" — agencies: USCIS, FBI, EOIR, OBIM, ICE, CBP, NVC, DOS
  Examples: "USCIS FOIA Response", "FBI FOIA Response"

FOR "Sent/Filed" DOCUMENTS:
- USCIS filings: use form number (e.g., "I-130", "I-485", "N-400")
- Court filings: Cross-Service, Witness List, Exhibits, Amendments to Application,
  Motion to Dismiss, Motion to Terminate, Motion to Consolidate, Motion to Continue,
  Motion to Sever, Written Pleadings, Brief to Immigration Judge, E-33, EOIR-42A, EOIR-42B, I-485, I-601
- BIA filings: BIA Appeal, BIA Brief, BIA Motion to Reopen, BIA Motion to Reconsider
- FOIA requests: "{Agency} FOIA Request" — agencies: USCIS, ICE, OBIM, FBI, CBP, DOS, NVC, EOIR
  Examples: "USCIS FOIA Request", "FBI FOIA Request"

FOR "Criminal Records" DOCUMENTS:
- Police reports: "Police Arrest Report - {offense}" (e.g., "Police Arrest Report - DWI")
- Court records: "Judgment of Conviction", "Indictment/Complaint", "Plea Agreement", "Sentencing Order"
- Record checks: "Public Records Request Confirmation - Criminal Records",
  "Open Records Request Response", "FOIA/Public Records Request"

FOR "Action" DOCUMENTS:
- Use exact label when matching: Called USCIS Hotline, Sent NVC Inquiry,
  Submitted NVC Documents on CEAC, Sent USCIS E-Request, Sent USCIS Ombudsman Request,
  Sent Request to Reschedule Interview, Sent Request to Reschedule Biometrics,
  Emailed VAWA Hotline, Emailed U Visa Hotline, Emailed OCC, Emailed ERO,
  Sent PD Request, Sent PD Request Follow-Up, Sent U Visa Certification Request

FOR "Supporting Doc(s)" DOCUMENTS:
- Use concise descriptive labels: Birth Certificate, Marriage Certificate, Passport,
  Driver's License, Social Security Card, Proof of Income, Tax Return, Pay Stubs,
  Utility Bill, Lease Agreement, Employment Letter, School Records, Medical Records,
  FOIA Questionnaire, Criminal History Questionnaire, Declaration, Affidavit

FOR "Note/Strategy" DOCUMENTS:
- Use descriptive labels: "Discussion w/ {person}", "Case review notes", "Strategy memo",
  "Review of {document type}", "Investigation notes"

IMPORTANT:
- Keep documentLabel concise — it becomes the task title prefix
- Do NOT include dates or client names in documentLabel — those are separate fields
- For documents NOT in this guide, infer the label a paralegal would use based on conventions above.
  Use the same style: "{Form Number}, {Notice Type}" for USCIS docs, "{Agency} {Document Type}" for
  agency correspondence, or concise descriptive labels matching immigration law terminology.`.trim();
}
