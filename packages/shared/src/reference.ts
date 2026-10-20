// Reference number formats (section 8).

function pad(value: number | string, width: number): string {
  return String(value).padStart(width, '0');
}

/** Strips a leading letter prefix and pads the numeric entity code to 6 digits. */
export function padEntityCode(entityCode: string): string {
  return pad(entityCode.replace(/^\D+/, ''), 6);
}

/** `E000077-T0006-N00005`. */
export function formatLeaveReference(entityCode: string, leaveTypeId: number, seq: number): string {
  return `E${padEntityCode(entityCode)}-T${pad(leaveTypeId, 4)}-N${pad(seq, 5)}`;
}

/** `C000077-G0002-N00001`. */
export function formatClaimReference(entityCode: string, groupId: number, seq: number): string {
  return `C${padEntityCode(entityCode)}-G${pad(groupId, 4)}-N${pad(seq, 5)}`;
}

/** `R000077-BANKDET-N00001`. */
export function formatChangeRequestReference(entityCode: string, typeCode: string, seq: number): string {
  return `R${padEntityCode(entityCode)}-${typeCode}-N${pad(seq, 5)}`;
}

/** `F000077-N00001`. */
export function formatFreeTextReference(entityCode: string, seq: number): string {
  return `F${padEntityCode(entityCode)}-N${pad(seq, 5)}`;
}

/** Leave in lieu: `L000077-T0013-N00001` (ASSUMPTION: format not observed). */
export function formatCreditLeaveReference(entityCode: string, leaveTypeId: number, seq: number): string {
  return `L${padEntityCode(entityCode)}-T${pad(leaveTypeId, 4)}-N${pad(seq, 5)}`;
}

export const LEAVE_REFERENCE_PATTERN = /^E\d{6}-T\d{4}-N\d{5}$/;

/** Keys used with the ReferenceSequence table. */
export const sequenceKeys = {
  leave: (employeeId: number, leaveTypeId: number) => `LEAVE:${employeeId}:${leaveTypeId}`,
  claim: (employeeId: number, groupId: number) => `CLAIM:${employeeId}:${groupId}`,
  changeRequest: (employeeId: number, typeCode: string) => `CR:${employeeId}:${typeCode}`,
  freeText: (employeeId: number) => `FREETEXT:${employeeId}`,
  creditLeave: (employeeId: number, leaveTypeId: number) => `CREDIT:${employeeId}:${leaveTypeId}`,
};
