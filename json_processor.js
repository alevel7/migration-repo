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
function main() {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d;
        const [jsonPath, dbName, collectionName] = process.argv.slice(2);
        const mongodbUri = process.env.MONGODB_URI;
        // if (!jsonPath || !dbName || !collectionName) {
        // 	console.error("Usage: ts-node json_processor.ts <jsonPath> <dbName> <collectionName>");
        // 	process.exit(1);
        // }
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
        const uniqueStaffs = Array.from(new Set(allStaffs.map((name) => name.toLowerCase()))).map((lowerName) => { var _a; return (_a = allStaffs.find((name) => name.toLowerCase() === lowerName)) !== null && _a !== void 0 ? _a : lowerName; });
        const uniqueClinics = Array.from(new Set(allClinics.map((name) => name.toLowerCase()))).map((lowerName) => { var _a; return (_a = allClinics.find((name) => name.toLowerCase() === lowerName)) !== null && _a !== void 0 ? _a : lowerName; });
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
            // create new appointment records
            const allAppointments = sourceRecords.flatMap((record) => record.encounters.map((encounter) => ({
                appointment_time: encounter.appointment_date,
                consultant: normalizePersonName(encounter.consultant),
                department: normalizePersonName(encounter.clinic),
                patient_hospital_no: record.hospital_no.trim(),
                secret_id: encounter.appointment_id.trim(),
            })));
            const uniqueAppointments = Array.from(new Map(allAppointments.map((appointment) => [appointment.secret_id, appointment])).values());
            console.log(`Mapping ${uniqueAppointments.length} records into...`);
            const mappedAppointment = [];
            for (const appointment of uniqueAppointments) {
                const { email } = createStaff(appointment.consultant, 0);
                const consultant = yield staffs.findOne({
                    email,
                });
                const { name } = createClinic(appointment.department, 0);
                const department = yield clinics.findOne({
                    name,
                });
                const patient = yield patients.findOne({
                    $or: [
                        { hospital_number: appointment.patient_hospital_no },
                        { old_hospital_number: appointment.patient_hospital_no },
                    ],
                });
                if (!consultant) {
                    console.warn(`Consultant not found for name: ${appointment.consultant}`);
                    throw new Error(`Consultant not found for name: ${appointment.consultant}`);
                }
                if (!patient) {
                    console.warn(`Patient not found for hospital number: ${appointment.patient_hospital_no}`);
                    throw new Error(`Patient not found for hospital number: ${appointment.patient_hospital_no}`);
                }
                if (!department) {
                    console.warn(`Department not found for name: ${appointment.department}`);
                    throw new Error(`Department not found for name: ${appointment.department}`);
                }
                console.log(`Done with appointment ${appointment.secret_id}`);
                mappedAppointment.push({
                    appointment_time: appointment.appointment_time,
                    consultant: (_a = consultant._id) === null || _a === void 0 ? void 0 : _a.toString(),
                    department: (_b = department._id) === null || _b === void 0 ? void 0 : _b.toString(),
                    patient: (_c = patient._id) === null || _c === void 0 ? void 0 : _c.toString(),
                    department_route: department.route,
                    secret_id: appointment.secret_id,
                });
            }
            console.log(`Importing ${uniqueAppointments.length} records into ${dbName}.${'appointmentRecords'}...`);
            const appointmentOperations = [];
            for (const appointment of mappedAppointment) {
                appointmentOperations.push({
                    updateOne: {
                        filter: { secret_id: appointment.secret_id },
                        update: { $setOnInsert: appointment },
                        upsert: true,
                    },
                });
            }
            yield insertInBatches(appointmentOperations, (batch) => __awaiter(this, void 0, void 0, function* () {
                yield appointmentRecords.bulkWrite(batch, { ordered: false });
            }), batchSize);
            console.log(`Imported ${mappedAppointment.length} records into ${dbName}.${'appointmentRecords'}`);
            // create new consultations records
            const allConsultations = sourceRecords.flatMap((record) => record.encounters.map((encounter) => {
                var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
                const clinicalNote = (_a = encounter.clinical_notes) === null || _a === void 0 ? void 0 : _a[0];
                if (!clinicalNote) {
                    throw new Error(`Missing clinical notes for appointment ID: ${encounter.appointment_id}`);
                }
                return {
                    complaintII: (_c = (_b = clinicalNote.chief_complaint) === null || _b === void 0 ? void 0 : _b.trim()) !== null && _c !== void 0 ? _c : "",
                    complaint_history: (_e = (_d = clinicalNote.history) === null || _d === void 0 ? void 0 : _d.trim()) !== null && _e !== void 0 ? _e : "",
                    uncoded_diagnosis: [(_g = (_f = clinicalNote.diagnosis) === null || _f === void 0 ? void 0 : _f.trim()) !== null && _g !== void 0 ? _g : ""].filter(Boolean),
                    examination: (_j = (_h = clinicalNote.assessment) === null || _h === void 0 ? void 0 : _h.trim()) !== null && _j !== void 0 ? _j : "",
                    notes: (_l = (_k = clinicalNote.plan) === null || _k === void 0 ? void 0 : _k.trim()) !== null && _l !== void 0 ? _l : "",
                    patient_hospital_no: record.hospital_no.trim(),
                    consultant: normalizePersonName(encounter.consultant),
                    department: normalizePersonName(encounter.clinic),
                    secret_id: encounter.appointment_id.trim(),
                };
            }));
            const uniqueConsultations = Array.from(new Map(allConsultations.map((consultation) => [consultation.secret_id, consultation])).values());
            console.log(`Mapping ${uniqueConsultations.length} records into...`);
            const mappedConsultation = [];
            for (const consultation of uniqueConsultations) {
                const { email } = createStaff(consultation.consultant, 0);
                const consultant = yield staffs.findOne({ email });
                const { name } = createClinic(consultation.department, 0);
                const department = yield clinics.findOne({ name });
                const patient = yield patients.findOne({
                    $or: [
                        { hospital_number: consultation.patient_hospital_no },
                        { old_hospital_number: consultation.patient_hospital_no },
                    ],
                });
                const appointment = yield appointmentRecords.findOne({ secret_id: consultation.secret_id });
                if (!appointment) {
                    console.warn(`Appointment not found for secret ID: ${consultation.secret_id}`);
                    throw new Error(`Appointment not found for secret ID: ${consultation.secret_id}`);
                }
                if (!patient) {
                    console.warn(`Patient not found for hospital number: ${consultation.patient_hospital_no}`);
                    throw new Error(`Patient not found for hospital number: ${consultation.patient_hospital_no}`);
                }
                if (!consultant) {
                    console.warn(`Consultant not found for name: ${consultation.consultant}`);
                    throw new Error(`Consultant not found for name: ${consultation.consultant}`);
                }
                if (!department) {
                    console.warn(`Department not found for name: ${consultation.department}`);
                    throw new Error(`Department not found for name: ${consultation.department}`);
                }
                console.log(`Done with consultation ${consultation.department}`);
                mappedConsultation.push({
                    complaintII: consultation.complaintII,
                    complaint_history: consultation.complaint_history,
                    uncoded_diagnosis: consultation.uncoded_diagnosis,
                    examination: consultation.examination,
                    notes: consultation.notes,
                    patient: (_d = patient._id) === null || _d === void 0 ? void 0 : _d.toString(),
                    department_route: department.route,
                    appointment: appointment.secret_id,
                });
            }
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
