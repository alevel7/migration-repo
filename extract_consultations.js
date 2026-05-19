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
const bson_1 = require("bson");
function chunkArray(items, size) {
    const chunks = [];
    for (let cursor = 0; cursor < items.length; cursor += size) {
        chunks.push(items.slice(cursor, cursor + size));
    }
    return chunks;
}
function normalizeToArray(input) {
    if (Array.isArray(input)) {
        return input.filter((item) => typeof item === "object" && item !== null && !Array.isArray(item));
    }
    return [];
}
function normalizePersonName(name) {
    return name.trim().replace(/\s+/g, " ");
}
function main() {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1, _2;
        const [jsonPath, outputPath] = process.argv.slice(2);
        const mongodbUri = process.env.MONGODB_URI;
        if (!jsonPath || !outputPath) {
            console.error("Usage: ts-node extract_consultations.ts <inputJsonPath> <outputJsonPath>");
            process.exit(1);
        }
        if (!mongodbUri) {
            console.error("Set MONGODB_URI in your environment before running this script.");
            process.exit(1);
        }
        try {
            console.log(`Reading JSON file from ${jsonPath}...`);
            const rawText = yield (0, promises_1.readFile)(jsonPath, "utf-8");
            const parsed = JSON.parse(rawText);
            const sourceRecords = normalizeToArray(parsed);
            if (sourceRecords.length === 0) {
                console.error("No valid object records found in the JSON input.");
                process.exit(1);
            }
            console.log(`Processing ${sourceRecords.length} source records...`);
            const uniquePatientHospitalNumbers = Array.from(new Set(sourceRecords.map((record) => record.hospital_no.trim()).filter(Boolean)));
            const uniqueAppointmentSecretIds = Array.from(new Set(sourceRecords.flatMap((record) => record.encounters.map((encounter) => encounter.appointment_id.trim()).filter(Boolean))));
            const patientLookup = new Map();
            const appointmentLookup = new Map();
            let firstStaffId;
            let firstStaffName = "";
            let targetDepartment;
            console.log("Fetching staff, departments, and patient details from MongoDB...");
            const client = new mongodb_1.MongoClient(mongodbUri);
            try {
                yield client.connect();
                const db = client.db();
                const patients = db.collection("patients");
                const appointmentRecords = db.collection("appointmentrecords");
                const staffs = db.collection("staffs");
                const departments = db.collection("departments");
                const firstStaff = yield staffs.findOne({}, { projection: { _id: 1, fname: 1, lname: 1 }, sort: { _id: 1 } });
                if (!(firstStaff === null || firstStaff === void 0 ? void 0 : firstStaff._id)) {
                    console.error("No staff found in the database. Cannot create appointments without a doctor.");
                    process.exit(1);
                }
                firstStaffId = firstStaff._id;
                firstStaffName = `${(_a = firstStaff.fname) !== null && _a !== void 0 ? _a : ""} ${(_b = firstStaff.lname) !== null && _b !== void 0 ? _b : ""}`.trim();
                console.log(`Using first staff as doctor: ${firstStaffName} (${firstStaffId})`);
                const allDepartments = yield departments.find({}, { projection: { _id: 1, name: 1, route: 1 } }).toArray();
                targetDepartment = (_d = (_c = allDepartments.find((department) => { var _a; return ((_a = department.name) === null || _a === void 0 ? void 0 : _a.trim().toLowerCase()) === "gopd"; })) !== null && _c !== void 0 ? _c : allDepartments[0]) !== null && _d !== void 0 ? _d : undefined;
                if (!(targetDepartment === null || targetDepartment === void 0 ? void 0 : targetDepartment._id)) {
                    console.error("No department found in the database. Cannot create appointments without a department.");
                    process.exit(1);
                }
                console.log(`Using department: ${targetDepartment.name} (${targetDepartment._id})`);
                for (const patientBatch of chunkArray(uniquePatientHospitalNumbers, 4000)) {
                    const patientDocs = yield patients.find({
                        $or: [
                            { hospital_number: { $in: patientBatch } },
                            { old_hospital_number: { $in: patientBatch } },
                        ],
                    }, { projection: { _id: 1, hospital_number: 1, old_hospital_number: 1, fname: 1, lname: 1, sex: 1 } }).toArray();
                    for (const patient of patientDocs) {
                        if (!patient._id) {
                            continue;
                        }
                        const patientData = {
                            _id: patient._id,
                            fname: (_e = patient.fname) !== null && _e !== void 0 ? _e : "",
                            lname: (_f = patient.lname) !== null && _f !== void 0 ? _f : "",
                            sex: (_g = patient.sex) !== null && _g !== void 0 ? _g : "",
                            hospital_number: (_l = (_j = (_h = patient.hospital_number) === null || _h === void 0 ? void 0 : _h.trim()) !== null && _j !== void 0 ? _j : (_k = patient.old_hospital_number) === null || _k === void 0 ? void 0 : _k.trim()) !== null && _l !== void 0 ? _l : "",
                        };
                        const hospitalNumber = (_m = patient.hospital_number) === null || _m === void 0 ? void 0 : _m.trim();
                        const oldHospitalNumber = (_o = patient.old_hospital_number) === null || _o === void 0 ? void 0 : _o.trim();
                        if (hospitalNumber) {
                            patientLookup.set(hospitalNumber, patientData);
                        }
                        if (oldHospitalNumber) {
                            patientLookup.set(oldHospitalNumber, patientData);
                        }
                    }
                }
                console.log(`Loaded ${patientLookup.size} patient records from database.`);
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
                            clinic: encounter.clinic,
                            secret_id: secretId,
                        });
                    }
                }
                const uniqueAppointments = Array.from(uniqueAppointmentMap.values());
                const mappedAppointments = [];
                let skippedAppointmentsForMissingPatient = 0;
                for (const appointment of uniqueAppointments) {
                    const patientData = patientLookup.get(appointment.patient_hospital_no);
                    if (!patientData) {
                        skippedAppointmentsForMissingPatient += 1;
                        continue;
                    }
                    mappedAppointments.push({
                        secret_id: appointment.secret_id,
                        appointment_time: appointment.appointment_time,
                        doctor: firstStaffId,
                        doctor_name: firstStaffName,
                        department: targetDepartment._id,
                        department_route: targetDepartment.route,
                        patient: patientData._id,
                        hospital_number: patientData.hospital_number,
                        patient_smart_code: patientData.hospital_number,
                        patient_sex: patientData.sex,
                        appointment_category: "physical",
                        appointment_type: "Instant",
                    });
                }
                console.log(`Upserting ${mappedAppointments.length} appointment records (skipped ${skippedAppointmentsForMissingPatient} with missing patient)...`);
                // Ensure index exists for faster upsert
                try {
                    yield appointmentRecords.createIndex({ secret_id: 1 });
                }
                catch (_3) {
                    // Index may already exist
                }
                const appointmentOps = mappedAppointments.map((appointment) => ({
                    updateOne: {
                        filter: { secret_id: appointment.secret_id },
                        update: { $setOnInsert: appointment },
                        upsert: true,
                    },
                }));
                for (const batch of chunkArray(appointmentOps, 4000)) {
                    yield appointmentRecords.bulkWrite(batch, { ordered: false });
                }
                // Single query for all appointments instead of batching
                const secretIds = mappedAppointments.map((appointment) => appointment.secret_id);
                const appointmentDocs = yield appointmentRecords.find({ secret_id: { $in: secretIds } }, { projection: { _id: 1, secret_id: 1 } }).toArray();
                for (const appointment of appointmentDocs) {
                    if (appointment._id && appointment.secret_id) {
                        appointmentLookup.set(appointment.secret_id, appointment._id);
                    }
                }
                console.log(`Loaded ${appointmentLookup.size} appointment _id entries.`);
            }
            finally {
                yield client.close();
            }
            const today = new Date().toISOString();
            const uniqueConsultationMap = new Map();
            let skippedForMissingAppointment = 0;
            let skippedForMissingPatient = 0;
            for (const record of sourceRecords) {
                for (const encounter of record.encounters) {
                    const secretId = encounter.appointment_id.trim();
                    if (!secretId) {
                        continue;
                    }
                    const clinicalNote = (_p = encounter.clinical_notes) === null || _p === void 0 ? void 0 : _p[0];
                    if (!clinicalNote) {
                        console.warn(`Missing clinical notes for appointment ID: ${encounter.appointment_id}`);
                        continue;
                    }
                    const appointmentId = appointmentLookup.get(secretId);
                    if (!appointmentId) {
                        skippedForMissingAppointment += 1;
                        continue;
                    }
                    const patientData = patientLookup.get(record.hospital_no.trim());
                    if (!patientData) {
                        skippedForMissingPatient += 1;
                        continue;
                    }
                    const patientName = `${patientData.fname} ${patientData.lname}`.trim();
                    uniqueConsultationMap.set(secretId, {
                        appointment: appointmentId,
                        patient: patientData._id,
                        complaintII: (_r = (_q = clinicalNote.chief_complaint) === null || _q === void 0 ? void 0 : _q.trim()) !== null && _r !== void 0 ? _r : "",
                        complaint_history: (_t = (_s = clinicalNote.history) === null || _s === void 0 ? void 0 : _s.trim()) !== null && _t !== void 0 ? _t : "",
                        uncoded_diagnosis: [(_v = (_u = clinicalNote.diagnosis) === null || _u === void 0 ? void 0 : _u.trim()) !== null && _v !== void 0 ? _v : ""].filter(Boolean),
                        examination: (_x = (_w = clinicalNote.assessment) === null || _w === void 0 ? void 0 : _w.trim()) !== null && _x !== void 0 ? _x : "",
                        notes: (_z = (_y = clinicalNote.plan) === null || _y === void 0 ? void 0 : _y.trim()) !== null && _z !== void 0 ? _z : "",
                        patient_name: patientName,
                        sex: patientData.sex,
                        department_route: (_0 = targetDepartment === null || targetDepartment === void 0 ? void 0 : targetDepartment.route) !== null && _0 !== void 0 ? _0 : "",
                        raised_by_name: normalizePersonName(encounter.consultant),
                        hospital_number: patientData.hospital_number,
                        secret_id: secretId,
                        is_follow_up: false,
                        complaint: [(_2 = (_1 = clinicalNote.chief_complaint) === null || _1 === void 0 ? void 0 : _1.trim()) !== null && _2 !== void 0 ? _2 : ""].filter(Boolean),
                        created_at: today,
                    });
                }
            }
            const uniqueConsultations = Array.from(uniqueConsultationMap.values());
            console.log(`Extracted ${uniqueConsultations.length} unique consultations.`);
            console.log(`Skipped ${skippedForMissingAppointment} for missing appointment and ${skippedForMissingPatient} for missing patient.`);
            console.log(`Writing to ${outputPath}...`);
            const outputJson = bson_1.EJSON.stringify(uniqueConsultations, undefined, 2, { relaxed: false });
            yield (0, promises_1.writeFile)(outputPath, outputJson, "utf-8");
            console.log(`Successfully wrote ${uniqueConsultations.length} consultation records to ${outputPath}`);
        }
        catch (error) {
            console.error("Extraction failed:", error);
            process.exit(1);
        }
    });
}
void main();
