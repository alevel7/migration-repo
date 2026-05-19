import { readFile, writeFile } from "node:fs/promises";
import { AnyBulkWriteOperation, MongoClient, ObjectId } from "mongodb";
import { EJSON } from "bson";

type RawRecord = {
    hospital_no: string;
    full_name: string;
    sex: string;
    encounters: {
        appointment_id: string;
        appointment_date: string;
        clinic: string;
        consultant: string;
        clinical_notes: {
            chief_complaint: string;
            history: string;
            diagnosis: string;
            assessment: string;
            plan: string;
        }[];
    }[];
};

type patient = {
    _id?: ObjectId;
    old_hospital_number: string;
    hospital_number: string;
    sex: string;
    fname: string;
    lname: string;
};

type staffRecord = {
    _id?: ObjectId;
    fname: string;
    lname: string;
    email: string;
};

type departmentDoc = {
    _id?: ObjectId;
    name: string;
    route: string;
};

type extractedConsultation = {
    appointment: ObjectId;
    patient: ObjectId;
    complaintII: string;
    complaint_history: string;
    uncoded_diagnosis: string[];
    examination: string;
    notes: string;
    patient_name: string;
    sex: string;
    department_route: string;
    raised_by_name: string;
    secret_id: string;
    is_follow_up: boolean;
    complaint: string[];
    created_at: string;
};

type appointmentRecord = {
    _id?: ObjectId;
    secret_id: string;
    appointment_time: string;
    doctor: ObjectId;
    doctor_name?: string;
    department?: ObjectId;
    patient: ObjectId;
    hospital_number: string;
    patient_smart_code: string;
    patient_sex: string;
    department_route?: string;
    appointment_category?: string;
    appointment_type?: string;
};

function chunkArray<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let cursor = 0; cursor < items.length; cursor += size) {
        chunks.push(items.slice(cursor, cursor + size));
    }
    return chunks;
}

function normalizeToArray(input: unknown): RawRecord[] {
    if (Array.isArray(input)) {
        return input.filter((item): item is RawRecord => typeof item === "object" && item !== null && !Array.isArray(item));
    }
    return [];
}

function normalizePersonName(name: string): string {
    return name.trim().replace(/\s+/g, " ");
}

async function main(): Promise<void> {
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
        const rawText = await readFile(jsonPath, "utf-8");
        const parsed = JSON.parse(rawText) as unknown;
        const sourceRecords = normalizeToArray(parsed);

        if (sourceRecords.length === 0) {
            console.error("No valid object records found in the JSON input.");
            process.exit(1);
        }

        console.log(`Processing ${sourceRecords.length} source records...`);

        const uniquePatientHospitalNumbers = Array.from(
            new Set(sourceRecords.map((record) => record.hospital_no.trim()).filter(Boolean)),
        );
        const uniqueAppointmentSecretIds = Array.from(
            new Set(
                sourceRecords.flatMap((record) =>
                    record.encounters.map((encounter) => encounter.appointment_id.trim()).filter(Boolean),
                ),
            ),
        );
        const patientLookup = new Map<string, { _id: ObjectId; fname: string; lname: string; sex: string; hospital_number: string }>();
        const appointmentLookup = new Map<string, ObjectId>();
        let firstStaffId: ObjectId | undefined;
        let firstStaffName = "";
        let targetDepartment: { _id: ObjectId; route: string; name: string } | undefined;

        console.log("Fetching staff, departments, and patient details from MongoDB...");
        const client = new MongoClient(mongodbUri);
        try {
            await client.connect();
            const db = client.db();
            const patients = db.collection<patient>("patients");
            const appointmentRecords = db.collection<appointmentRecord>("appointmentrecords");
            const staffs = db.collection<staffRecord>("staffs");
            const departments = db.collection<departmentDoc>("departments");

            const firstStaff = await staffs.findOne({}, { projection: { _id: 1, fname: 1, lname: 1 }, sort: { _id: 1 } });
            if (!firstStaff?._id) {
                console.error("No staff found in the database. Cannot create appointments without a doctor.");
                process.exit(1);
            }
            firstStaffId = firstStaff._id;
            firstStaffName = `${firstStaff.fname ?? ""} ${firstStaff.lname ?? ""}`.trim();
            console.log(`Using first staff as doctor: ${firstStaffName} (${firstStaffId})`);

            const allDepartments = await departments.find({}, { projection: { _id: 1, name: 1, route: 1 } }).toArray();
            targetDepartment = allDepartments.find((department) => department.name?.trim().toLowerCase() === "gopd")
                ?? allDepartments[0]
                ?? undefined;

            if (!targetDepartment?._id) {
                console.error("No department found in the database. Cannot create appointments without a department.");
                process.exit(1);
            }
            console.log(`Using department: ${targetDepartment.name} (${targetDepartment._id})`);

            for (const patientBatch of chunkArray(uniquePatientHospitalNumbers, 4000)) {
                const patientDocs = await patients.find(
                    {
                        $or: [
                            { hospital_number: { $in: patientBatch } },
                            { old_hospital_number: { $in: patientBatch } },
                        ],
                    },
                    { projection: { _id: 1, hospital_number: 1, old_hospital_number: 1, fname: 1, lname: 1, sex: 1 } },
                ).toArray();

                for (const patient of patientDocs) {
                    if (!patient._id) {
                        continue;
                    }

                    const patientData = {
                        _id: patient._id,
                        fname: patient.fname ?? "",
                        lname: patient.lname ?? "",
                        sex: patient.sex ?? "",
                        hospital_number: patient.hospital_number?.trim() ?? patient.old_hospital_number?.trim() ?? "",
                    };

                    const hospitalNumber = patient.hospital_number?.trim();
                    const oldHospitalNumber = patient.old_hospital_number?.trim();
                    if (hospitalNumber) {
                        patientLookup.set(hospitalNumber, patientData);
                    }
                    if (oldHospitalNumber) {
                        patientLookup.set(oldHospitalNumber, patientData);
                    }
                }
            }

            console.log(`Loaded ${patientLookup.size} patient records from database.`);

            const uniqueAppointmentMap = new Map<string, {
                appointment_time: string;
                consultant: string;
                department: string;
                patient_hospital_no: string;
                clinic: string;
                secret_id: string;
            }>();
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
            const mappedAppointments: appointmentRecord[] = [];
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
                    doctor: firstStaffId!,
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
				await appointmentRecords.createIndex({ secret_id: 1 });
			} catch {
				// Index may already exist
			}

			const appointmentOps: AnyBulkWriteOperation<appointmentRecord>[] = mappedAppointments.map((appointment) => ({
				updateOne: {
					filter: { secret_id: appointment.secret_id },
					update: { $setOnInsert: appointment },
					upsert: true,
				},
			}));

			for (const batch of chunkArray(appointmentOps, 4000)) {
				await appointmentRecords.bulkWrite(batch, { ordered: false });
			}

			// Single query for all appointments instead of batching
			const secretIds = mappedAppointments.map((appointment) => appointment.secret_id);
			const appointmentDocs = await appointmentRecords.find(
				{ secret_id: { $in: secretIds } },
				{ projection: { _id: 1, secret_id: 1 } },
			).toArray();

			for (const appointment of appointmentDocs) {
				if (appointment._id && appointment.secret_id) {
					appointmentLookup.set(appointment.secret_id, appointment._id);
				}
			}

			console.log(`Loaded ${appointmentLookup.size} appointment _id entries.`);
		} finally {
            await client.close();
        }

        const today = new Date().toISOString();
        const uniqueConsultationMap = new Map<string, extractedConsultation>();
        let skippedForMissingAppointment = 0;
        let skippedForMissingPatient = 0;

        for (const record of sourceRecords) {
            for (const encounter of record.encounters) {
                const secretId = encounter.appointment_id.trim();
                if (!secretId) {
                    continue;
                }

                const clinicalNote = encounter.clinical_notes?.[0];
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
                    complaintII: clinicalNote.chief_complaint?.trim() ?? "",
                    complaint_history: clinicalNote.history?.trim() ?? "",
                    uncoded_diagnosis: [clinicalNote.diagnosis?.trim() ?? ""].filter(Boolean),
                    examination: clinicalNote.assessment?.trim() ?? "",
                    notes: clinicalNote.plan?.trim() ?? "",
                    patient_name: patientName,
                    sex: patientData.sex,
                    department_route: targetDepartment?.route ?? "",
                    raised_by_name: normalizePersonName(encounter.consultant),
                    secret_id: secretId,
                    is_follow_up: false,
                    complaint: [clinicalNote.chief_complaint?.trim() ?? ""].filter(Boolean),
                    created_at: today,
                });
            }
        }

        const uniqueConsultations = Array.from(uniqueConsultationMap.values());
        console.log(`Extracted ${uniqueConsultations.length} unique consultations.`);
        console.log(`Skipped ${skippedForMissingAppointment} for missing appointment and ${skippedForMissingPatient} for missing patient.`);

        console.log(`Writing to ${outputPath}...`);
        const outputJson = EJSON.stringify(uniqueConsultations, undefined, 2, { relaxed: false });
        await writeFile(outputPath, outputJson, "utf-8");
        console.log(`Successfully wrote ${uniqueConsultations.length} consultation records to ${outputPath}`);
    } catch (error: unknown) {
        console.error("Extraction failed:", error);
        process.exit(1);
    }
}

void main();
