"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = require("node:fs/promises");
const mongodb_1 = require("mongodb");
function normalizeToArray(input) {
    if (Array.isArray(input)) {
        return input.filter((item) => typeof item === "object" && item !== null && !Array.isArray(item));
    }
    // if (typeof input === "object" && input !== null) {
    // 	const maybeObject = input as RawRecord;
    // 	// if (Array.isArray(maybeObject.encounters)) {
    // 	// 	return maybeObject.records.filter(
    // 	// 		(item): item is RawRecord => typeof item === "object" && item !== null && !Array.isArray(item),
    // 	// 	);
    // 	// }
    // 	return [maybeObject];
    // }
    return [];
}
function createStaff(name, index) {
    const parts = normalizePersonName(name).split(" ").filter(Boolean);
    const firstName = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    const lastName = parts.length >= 2 ? parts[parts.length - 1] : "";
    return {
        fname: firstName,
        lname: lastName,
        email: `${firstName === null || firstName === void 0 ? void 0 : firstName.toLowerCase()}.${lastName === null || lastName === void 0 ? void 0 : lastName.toLowerCase()}@example.com`,
        username: `${firstName === null || firstName === void 0 ? void 0 : firstName.toLowerCase()}.${lastName === null || lastName === void 0 ? void 0 : lastName.toLowerCase()}`,
        phone: `080${index.toString().padStart(8, "0")}`,
        smart_code: `SC${index.toString().padStart(4, "0")}`,
    };
}
function createClinic(name, index) {
    return {
        name: normalizePersonName(name),
        route: normalizePersonName(name).toLowerCase().replace(/\s+/g, "-"),
    };
}
function normalizePersonName(name) {
    return name.trim().replace(/\s+/g, " ");
}
function insertInBatches(docs, insertBatch, size) {
    return __awaiter(this, void 0, void 0, function* () {
        for (let cursor = 0; cursor < docs.length; cursor += size) {
            const batch = docs.slice(cursor, cursor + size);
            yield insertBatch(batch);
        }
    });
}
function chunkArray(items, size) {
    const chunks = [];
    for (let cursor = 0; cursor < items.length; cursor += size) {
        chunks.push(items.slice(cursor, cursor + size));
    }
    return chunks;
}
function uniqueByLowerCase(values) {
    const firstSeen = new Map();
    for (const value of values) {
        const lowerCaseValue = value.toLowerCase();
        if (!firstSeen.has(lowerCaseValue)) {
            firstSeen.set(lowerCaseValue, value);
        }
    }
    return Array.from(firstSeen.values());
}
function main() {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
        const [jsonPath, dbName, collectionName] = process.argv.slice(2);
        const mongodbUri = process.env.MONGODB_URI;
        console.log("database url", mongodbUri);
        if (!jsonPath || !dbName) {
            console.error("Usage: ts-node json_processor.ts <jsonPath> <dbName> <collectionName>");
            process.exit(1);
        }
        if (!mongodbUri) {
            console.error("Set MONGODB_URI in your environment before running this script.");
            process.exit(1);
        }
        const rawText = yield (0, promises_1.readFile)(jsonPath, "utf-8");
        const parsed = JSON.parse(rawText);
        const sourceRecords = normalizeToArray(parsed);
        if (sourceRecords.length === 0) {
            console.error("No valid object records found in the JSON input.");
            process.exit(1);
        }
        const allStaffs = sourceRecords.flatMap(record => record.encounters
            .map((encounter) => normalizePersonName(encounter.consultant))
            .filter((consultant) => consultant.length > 0));
        const allClinics = sourceRecords.flatMap(record => record.encounters
            .map((encounter) => encounter.clinic.trim())
            .filter((clinic) => clinic.length > 0));
        const uniqueStaffs = uniqueByLowerCase(allStaffs);
        const uniqueClinics = uniqueByLowerCase(allClinics);
        const transformedStaff = uniqueStaffs.map((name, index) => createStaff(name, index));
        const transformedClinic = uniqueClinics.map((name, index) => createClinic(name, index));
        const client = new mongodb_1.MongoClient(mongodbUri);
        const batchSize = 1000;
        try {
            yield client.connect();
            // const collection = client.db(dbName).collection<TransformedRecord>(collectionName);
            const staffs = client.db(dbName).collection('staffs');
            const patients = client.db(dbName).collection('patients');
            const clinics = client.db(dbName).collection('departments');
            const appointmentRecords = client.db(dbName).collection('appointmentRecords');
            const consultations = client.db(dbName).collection('consultations');
            const indexJobs = [
                staffs.createIndex({ email: 1 }, { unique: true }),
                clinics.createIndex({ name: 1 }, { unique: true }),
                patients.createIndex({ hospital_number: 1 }),
                patients.createIndex({ old_hospital_number: 1 }),
                appointmentRecords.createIndex({ secret_id: 1 }, { unique: true }),
                consultations.createIndex({ appointment: 1 }, { unique: true }),
            ];
            const indexResults = yield Promise.allSettled(indexJobs);
            for (const [index, result] of indexResults.entries()) {
                if (result.status === "rejected") {
                    console.warn(`Index setup warning #${index + 1}: ${result.reason}`);
                }
            }
            const uniquePatientHospitalNumbers = Array.from(new Set(sourceRecords.map((record) => record.hospital_no.trim()).filter(Boolean)));
            // create new staffs
            const staffOperations = transformedStaff.map((staff) => ({
                updateOne: {
                    filter: { email: staff.email },
                    update: { $setOnInsert: staff },
                    upsert: true,
                },
            }));
            console.log(`Importing ${transformedStaff.length} records into ${dbName}.${'staffs'}...`);
            yield insertInBatches(staffOperations, (batch) => __awaiter(this, void 0, void 0, function* () {
                yield staffs.bulkWrite(batch, { ordered: false });
            }), batchSize);
            console.log(`Imported ${transformedStaff.length} records into ${dbName}.${'staffs'}`);
            // create new clinics
            const clinicOperations = transformedClinic.map((clinic) => ({
                updateOne: {
                    filter: { name: clinic.name },
                    update: { $setOnInsert: clinic },
                    upsert: true,
                },
            }));
            console.log(`Importing ${transformedClinic.length} records into ${dbName}.${'departments'}...`);
            yield insertInBatches(clinicOperations, (batch) => __awaiter(this, void 0, void 0, function* () {
                yield clinics.bulkWrite(batch, { ordered: false });
            }), batchSize);
            console.log(`Imported ${transformedClinic.length} records into ${dbName}.${'departments'}`);
            const staffLookup = new Map();
            const staffEmails = transformedStaff.map((staff) => staff.email);
            for (const emailBatch of chunkArray(staffEmails, batchSize)) {
                const staffDocs = yield staffs.find({ email: { $in: emailBatch } }, { projection: { _id: 1, email: 1 } }).toArray();
                for (const staff of staffDocs) {
                    if ((staff === null || staff === void 0 ? void 0 : staff._id) && staff.email) {
                        staffLookup.set(staff.email, staff._id.toString());
                    }
                }
            }
            const clinicLookup = new Map();
            const clinicNames = transformedClinic.map((clinic) => clinic.name);
            for (const clinicBatch of chunkArray(clinicNames, batchSize)) {
                const clinicDocs = yield clinics.find({ name: { $in: clinicBatch } }, { projection: { _id: 1, name: 1, route: 1 } }).toArray();
                for (const clinic of clinicDocs) {
                    if ((clinic === null || clinic === void 0 ? void 0 : clinic._id) && clinic.name) {
                        clinicLookup.set(normalizePersonName(clinic.name).toLowerCase(), {
                            id: clinic._id.toString(),
                            route: clinic.route,
                        });
                    }
                }
            }
            const patientLookup = new Map();
            for (const patientBatch of chunkArray(uniquePatientHospitalNumbers, 4000)) {
                const patientDocs = yield patients.find({
                    $or: [
                        { hospital_number: { $in: patientBatch } },
                        { old_hospital_number: { $in: patientBatch } },
                    ],
                }, { projection: { _id: 1, hospital_number: 1, old_hospital_number: 1 } }).toArray();
                for (const patient of patientDocs) {
                    if (!(patient === null || patient === void 0 ? void 0 : patient._id)) {
                        continue;
                    }
                    const patientId = patient._id;
                    const hospitalNumber = (_a = patient.hospital_number) === null || _a === void 0 ? void 0 : _a.trim();
                    const oldHospitalNumber = (_b = patient.old_hospital_number) === null || _b === void 0 ? void 0 : _b.trim();
                    if (hospitalNumber) {
                        patientLookup.set(hospitalNumber, patientId);
                    }
                    if (oldHospitalNumber) {
                        patientLookup.set(oldHospitalNumber, patientId);
                    }
                }
            }
            const uniqueAppointmentMap = new Map();
            for (const record of sourceRecords) {
                for (const encounter of record.encounters) {
                    const secretId = encounter.appointment_id.trim();
                    if (!secretId) {
                        continue;
                    }
                    uniqueAppointmentMap.set(secretId, {
                        appointment_time: encounter.appointment_date,
                        consultant: normalizePersonName(encounter.consultant),
                        department: normalizePersonName(encounter.clinic),
                        patient_hospital_no: record.hospital_no.trim(),
                        secret_id: secretId,
                    });
                }
            }
            const uniqueAppointments = Array.from(uniqueAppointmentMap.values());
            console.log(`Mapping ${uniqueAppointments.length} records into appointmentRecords...`);
            const mappedAppointment = [];
            let skippedAppointmentsForMissingPatient = 0;
            for (const [index, appointment] of uniqueAppointments.entries()) {
                const { email } = createStaff(appointment.consultant, 0);
                const consultantId = staffLookup.get(email);
                const departmentLookupKey = normalizePersonName(appointment.department).toLowerCase();
                const department = clinicLookup.get(departmentLookupKey);
                const patientId = patientLookup.get(appointment.patient_hospital_no);
                if (!consultantId) {
                    console.warn(`Consultant not found for name: ${appointment.consultant}`);
                }
                if (!patientId) {
                    skippedAppointmentsForMissingPatient += 1;
                    console.warn(`Patient not found for hospital number: ${appointment.patient_hospital_no}`);
                    continue;
                }
                if (!department) {
                    console.warn(`Department not found for name: ${appointment.department}`);
                }
                mappedAppointment.push({
                    appointment_time: appointment.appointment_time,
                    consultant: consultantId,
                    department: department === null || department === void 0 ? void 0 : department.id,
                    patient: patientId,
                    department_route: department === null || department === void 0 ? void 0 : department.route,
                    secret_id: appointment.secret_id,
                });
                if ((index + 1) % 1000 === 0) {
                    console.log(`Mapped ${index + 1}/${uniqueAppointments.length} appointment records...`);
                }
            }
            console.log(`Importing ${mappedAppointment.length} records into ${dbName}.${'appointmentRecords'}...`);
            const appointmentOperations = mappedAppointment.map((appointment) => ({
                updateOne: {
                    filter: { secret_id: appointment.secret_id },
                    update: { $setOnInsert: appointment },
                    upsert: true,
                },
            }));
            yield insertInBatches(appointmentOperations, (batch) => __awaiter(this, void 0, void 0, function* () {
                yield appointmentRecords.bulkWrite(batch, { ordered: false });
            }), batchSize);
            console.log(`Imported ${mappedAppointment.length} records into ${dbName}.${'appointmentRecords'} (skipped ${skippedAppointmentsForMissingPatient} with missing patient)`);
            const appointmentLookup = new Map();
            const appointmentSecretIds = mappedAppointment.map((appointment) => appointment.secret_id);
            for (const secretIdBatch of chunkArray(appointmentSecretIds, 4000)) {
                const appointmentDocs = yield appointmentRecords.find({ secret_id: { $in: secretIdBatch } }, { projection: { _id: 1, secret_id: 1 } }).toArray();
                for (const appointment of appointmentDocs) {
                    if (appointment._id && appointment.secret_id) {
                        appointmentLookup.set(appointment.secret_id, appointment._id);
                    }
                }
            }
            // create new consultations records
            const uniqueConsultationMap = new Map();
            for (const record of sourceRecords) {
                for (const encounter of record.encounters) {
                    const secretId = encounter.appointment_id.trim();
                    if (!secretId) {
                        continue;
                    }
                    const clinicalNote = (_c = encounter.clinical_notes) === null || _c === void 0 ? void 0 : _c[0];
                    if (!clinicalNote) {
                        throw new Error(`Missing clinical notes for appointment ID: ${encounter.appointment_id}`);
                    }
                    uniqueConsultationMap.set(secretId, {
                        complaintII: (_e = (_d = clinicalNote.chief_complaint) === null || _d === void 0 ? void 0 : _d.trim()) !== null && _e !== void 0 ? _e : "",
                        complaint_history: (_g = (_f = clinicalNote.history) === null || _f === void 0 ? void 0 : _f.trim()) !== null && _g !== void 0 ? _g : "",
                        uncoded_diagnosis: [(_j = (_h = clinicalNote.diagnosis) === null || _h === void 0 ? void 0 : _h.trim()) !== null && _j !== void 0 ? _j : ""].filter(Boolean),
                        examination: (_l = (_k = clinicalNote.assessment) === null || _k === void 0 ? void 0 : _k.trim()) !== null && _l !== void 0 ? _l : "",
                        notes: (_o = (_m = clinicalNote.plan) === null || _m === void 0 ? void 0 : _m.trim()) !== null && _o !== void 0 ? _o : "",
                        patient_hospital_no: record.hospital_no.trim(),
                        consultant: normalizePersonName(encounter.consultant),
                        department: normalizePersonName(encounter.clinic),
                        secret_id: secretId,
                    });
                }
            }
            const uniqueConsultations = Array.from(uniqueConsultationMap.values());
            console.log(`Mapping ${uniqueConsultations.length} records into consultations...`);
            const mappedConsultation = [];
            let skippedConsultationsForMissingPatient = 0;
            for (const [index, consultation] of uniqueConsultations.entries()) {
                const { email } = createStaff(consultation.consultant, 0);
                const consultantId = staffLookup.get(email);
                const department = clinicLookup.get(normalizePersonName(consultation.department).toLowerCase());
                const patientId = patientLookup.get(consultation.patient_hospital_no);
                const appointmentId = appointmentLookup.get(consultation.secret_id);
                if (!appointmentId) {
                    console.warn(`Appointment not found for secret ID: ${consultation.secret_id}`);
                    continue;
                }
                if (!patientId) {
                    skippedConsultationsForMissingPatient += 1;
                    console.warn(`Patient not found for hospital number: ${consultation.patient_hospital_no}`);
                    continue;
                }
                if (!consultantId) {
                    console.warn(`Consultant not found for name: ${consultation.consultant}`);
                }
                if (!department) {
                    console.warn(`Department not found for name: ${consultation.department}`);
                }
                mappedConsultation.push({
                    complaintII: consultation.complaintII,
                    complaint_history: consultation.complaint_history,
                    uncoded_diagnosis: consultation.uncoded_diagnosis,
                    examination: consultation.examination,
                    notes: consultation.notes,
                    patient: patientId,
                    department_route: department === null || department === void 0 ? void 0 : department.route,
                    appointment: appointmentId,
                });
                if ((index + 1) % 1000 === 0) {
                    console.log(`Mapped ${index + 1}/${uniqueConsultations.length} consultation records...`);
                }
            }
            console.log(`Consultations skipped for missing patient: ${skippedConsultationsForMissingPatient}`);
            console.log(`Importing ${mappedConsultation.length} records into ${dbName}.${'consultations'}...`);
            const consultationOperations = [];
            for (const consultation of mappedConsultation) {
                consultationOperations.push({
                    updateOne: {
                        filter: { appointment: consultation.appointment },
                        update: { $setOnInsert: consultation },
                        upsert: true,
                    },
                });
            }
            yield insertInBatches(consultationOperations, (batch) => __awaiter(this, void 0, void 0, function* () {
                yield consultations.bulkWrite(batch, { ordered: false });
            }), batchSize);
            console.log(`Imported ${mappedConsultation.length} records into ${dbName}.${collectionName}`);
        }
        finally {
            yield client.close();
        }
    });
}
void main().catch((error) => {
    console.error("Import failed:", error);
    process.exit(1);
});
