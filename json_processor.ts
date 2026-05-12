import { readFile } from "node:fs/promises";
import { MongoClient, OptionalId, AnyBulkWriteOperation } from "mongodb";

// type RawRecord = Record<string, unknown>;
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
		}[]
	}[]
}

type staffName = {
	fname: string;
	lname: string;
	email: string;
	username: string;
	phone: string;
	smart_code: string;
}

type Clinic = {
	name: string;
	route: string;
}

type appointmentRecord = {
	appointment_time: string;
	consultant?: string;
	department?: string;
	patient: string;
	department_route?: string;
	secret_id: string // not part of the main app schema but added here for easy retrieval of the appointment record for the consultation record
}

type consultationRecord = {
	complaintII: string;
	complaint_history: string;
	uncoded_diagnosis: string[];
	examination: string;
	notes: string;
	appointment: string;
	patient: string;
	department_route?: string;
}

type patient = {
	old_hospital_number: string;
	hospital_number: string;
}



function normalizeToArray(input: unknown): RawRecord[] {
	if (Array.isArray(input)) {
		return input.filter((item): item is RawRecord => typeof item === "object" && item !== null && !Array.isArray(item));
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



function createStaff(name: string, index: number): staffName {
	const parts = normalizePersonName(name).split(" ").filter(Boolean);
	const firstName = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
	const lastName = parts.length >= 2 ? parts[parts.length - 1] : "";
	return {
		fname: firstName,
		lname: lastName,
		email: `${firstName?.toLowerCase()}.${lastName?.toLowerCase()}@example.com`,
		username: `${firstName?.toLowerCase()}.${lastName?.toLowerCase()}`,
		phone: `080${index.toString().padStart(8, "0")}`,
		smart_code: `SC${index.toString().padStart(4, "0")}`,
	}
}

function createClinic(name: string, index: number): Clinic {
	return {
		name: normalizePersonName(name),
		route: normalizePersonName(name).toLowerCase().replace(/\s+/g, "-"),
	}
}

function normalizePersonName(name: string): string {
	return name.trim().replace(/\s+/g, " ");
}

async function insertInBatches<T>(
	docs: OptionalId<T>[],
	insertBatch: (batch: OptionalId<T>[]) => Promise<void>,
	size: number,
): Promise<void> {
	for (let cursor = 0; cursor < docs.length; cursor += size) {
		const batch = docs.slice(cursor, cursor + size);
		await insertBatch(batch);
	}
}

function chunkArray<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let cursor = 0; cursor < items.length; cursor += size) {
		chunks.push(items.slice(cursor, cursor + size));
	}
	return chunks;
}

function uniqueByLowerCase(values: string[]): string[] {
	const firstSeen = new Map<string, string>();
	for (const value of values) {
		const lowerCaseValue = value.toLowerCase();
		if (!firstSeen.has(lowerCaseValue)) {
			firstSeen.set(lowerCaseValue, value);
		}
	}
	return Array.from(firstSeen.values());
}

async function main(): Promise<void> {
	const [jsonPath, dbName, collectionName] = process.argv.slice(2);
	const mongodbUri = process.env.MONGODB_URI;

	console.log("database url", mongodbUri)
	if (!jsonPath || !dbName) {
		console.error("Usage: ts-node json_processor.ts <jsonPath> <dbName> <collectionName>");
		process.exit(1);
	}

	if (!mongodbUri) {
		console.error("Set MONGODB_URI in your environment before running this script.");
		process.exit(1);
	}

	const rawText = await readFile(jsonPath, "utf-8");
	const parsed = JSON.parse(rawText) as unknown;
	const sourceRecords = normalizeToArray(parsed);

	if (sourceRecords.length === 0) {
		console.error("No valid object records found in the JSON input.");
		process.exit(1);
	}
	const allStaffs = sourceRecords.flatMap(record =>
		record.encounters
			.map((encounter) => normalizePersonName(encounter.consultant))
			.filter((consultant) => consultant.length > 0),
	);
	const allClinics = sourceRecords.flatMap(record =>
		record.encounters
			.map((encounter) => encounter.clinic.trim())
			.filter((clinic) => clinic.length > 0),
	);

	const uniqueStaffs = uniqueByLowerCase(allStaffs);
	const uniqueClinics = uniqueByLowerCase(allClinics);

	const transformedStaff = uniqueStaffs.map((name, index) => createStaff(name, index));
	const transformedClinic = uniqueClinics.map((name, index) => createClinic(name, index));

	const client = new MongoClient(mongodbUri);
	const batchSize = 1000;


	try {
		await client.connect();
		// const collection = client.db(dbName).collection<TransformedRecord>(collectionName);
		const staffs = client.db(dbName).collection<staffName>('staffs');
		const patients = client.db(dbName).collection<patient>('patients');
		const clinics = client.db(dbName).collection<Clinic>('departments');
		const appointmentRecords = client.db(dbName).collection<appointmentRecord>('appointmentRecords');
		const consultations = client.db(dbName).collection<consultationRecord>('consultations');

		const indexJobs = [
			staffs.createIndex({ email: 1 }, { unique: true }),
			clinics.createIndex({ name: 1 }, { unique: true }),
			patients.createIndex({ hospital_number: 1 }),
			patients.createIndex({ old_hospital_number: 1 }),
			appointmentRecords.createIndex({ secret_id: 1 }, { unique: true }),
			consultations.createIndex({ appointment: 1 }, { unique: true }),
		];
		const indexResults = await Promise.allSettled(indexJobs);
		for (const [index, result] of indexResults.entries()) {
			if (result.status === "rejected") {
				console.warn(`Index setup warning #${index + 1}: ${result.reason}`);
			}
		}

		const uniquePatientHospitalNumbers = Array.from(
			new Set(sourceRecords.map((record) => record.hospital_no.trim()).filter(Boolean)),
		);

		// create new staffs
		const staffOperations: AnyBulkWriteOperation<staffName>[] = transformedStaff.map((staff) => ({
			updateOne: {
				filter: { email: staff.email },
				update: { $setOnInsert: staff },
				upsert: true,
			},
		}));

		console.log(`Importing ${transformedStaff.length} records into ${dbName}.${'staffs'}...`);
		await insertInBatches<AnyBulkWriteOperation<staffName>>(staffOperations, async (batch) => {
			await staffs.bulkWrite(batch, { ordered: false });
		}, batchSize);
		console.log(`Imported ${transformedStaff.length} records into ${dbName}.${'staffs'}`);


		// create new clinics
		const clinicOperations: AnyBulkWriteOperation<Clinic>[] = transformedClinic.map((clinic) => ({
			updateOne: {
				filter: { name: clinic.name },
				update: { $setOnInsert: clinic },
				upsert: true,
			},
		}));

		console.log(`Importing ${transformedClinic.length} records into ${dbName}.${'departments'}...`);
		await insertInBatches<AnyBulkWriteOperation<Clinic>>(clinicOperations, async (batch) => {
			await clinics.bulkWrite(batch, { ordered: false });
		}, batchSize);
		console.log(`Imported ${transformedClinic.length} records into ${dbName}.${'departments'}`);

		const staffLookup = new Map<string, string>();
		const staffEmails = transformedStaff.map((staff) => staff.email);
		for (const emailBatch of chunkArray(staffEmails, batchSize)) {
			const staffDocs = await staffs.find(
				{ email: { $in: emailBatch } },
				{ projection: { _id: 1, email: 1 } },
			).toArray();
			for (const staff of staffDocs) {
				if (staff?._id && staff.email) {
					staffLookup.set(staff.email, staff._id.toString());
				}
			}
		}

		const clinicLookup = new Map<string, { id: string; route: string }>();
		const clinicNames = transformedClinic.map((clinic) => clinic.name);
		for (const clinicBatch of chunkArray(clinicNames, batchSize)) {
			const clinicDocs = await clinics.find(
				{ name: { $in: clinicBatch } },
				{ projection: { _id: 1, name: 1, route: 1 } },
			).toArray();
			for (const clinic of clinicDocs) {
				if (clinic?._id && clinic.name) {
					clinicLookup.set(normalizePersonName(clinic.name).toLowerCase(), {
						id: clinic._id.toString(),
						route: clinic.route,
					});
				}
			}
		}

		const patientLookup = new Map<string, string>();
		for (const patientBatch of chunkArray(uniquePatientHospitalNumbers, 4000)) {
			const patientDocs = await patients.find(
				{
					$or: [
						{ hospital_number: { $in: patientBatch } },
						{ old_hospital_number: { $in: patientBatch } },
					],
				},
				{ projection: { _id: 1, hospital_number: 1, old_hospital_number: 1 } },
			).toArray();

			for (const patient of patientDocs) {
				if (!patient?._id) {
					continue;
				}
				const patientId = patient._id.toString();
				const hospitalNumber = patient.hospital_number?.trim();
				const oldHospitalNumber = patient.old_hospital_number?.trim();
				if (hospitalNumber) {
					patientLookup.set(hospitalNumber, patientId);
				}
				if (oldHospitalNumber) {
					patientLookup.set(oldHospitalNumber, patientId);
				}
			}
		}

		const uniqueAppointmentMap = new Map<string, {
			appointment_time: string;
			consultant: string;
			department: string;
			patient_hospital_no: string;
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
					secret_id: secretId,
				});
			}
		}

		const uniqueAppointments = Array.from(uniqueAppointmentMap.values());
		console.log(`Mapping ${uniqueAppointments.length} records into appointmentRecords...`);
		const mappedAppointment: appointmentRecord[] = [];
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
				department: department?.id,
				patient: patientId,
				department_route: department?.route,
				secret_id: appointment.secret_id,
			});

			if ((index + 1) % 1000 === 0) {
				console.log(`Mapped ${index + 1}/${uniqueAppointments.length} appointment records...`);
			}
		}

		console.log(`Importing ${mappedAppointment.length} records into ${dbName}.${'appointmentRecords'}...`);
		const appointmentOperations: AnyBulkWriteOperation<appointmentRecord>[] = mappedAppointment.map((appointment) => ({
			updateOne: {
				filter: { secret_id: appointment.secret_id },
				update: { $setOnInsert: appointment },
				upsert: true,
			},
		}));
		await insertInBatches<AnyBulkWriteOperation<appointmentRecord>>(appointmentOperations, async (batch) => {
			await appointmentRecords.bulkWrite(batch, { ordered: false });
		}, batchSize);
		console.log(`Imported ${mappedAppointment.length} records into ${dbName}.${'appointmentRecords'} (skipped ${skippedAppointmentsForMissingPatient} with missing patient)`);

		// create new consultations records
		const uniqueConsultationMap = new Map<string, {
			complaintII: string;
			complaint_history: string;
			uncoded_diagnosis: string[];
			examination: string;
			notes: string;
			patient_hospital_no: string;
			consultant: string;
			department: string;
			secret_id: string;
		}>();

		for (const record of sourceRecords) {
			for (const encounter of record.encounters) {
				const secretId = encounter.appointment_id.trim();
				if (!secretId) {
					continue;
				}

				const clinicalNote = encounter.clinical_notes?.[0];
				if (!clinicalNote) {
					throw new Error(`Missing clinical notes for appointment ID: ${encounter.appointment_id}`);
				}

				uniqueConsultationMap.set(secretId, {
					complaintII: clinicalNote.chief_complaint?.trim() ?? "",
					complaint_history: clinicalNote.history?.trim() ?? "",
					uncoded_diagnosis: [clinicalNote.diagnosis?.trim() ?? ""].filter(Boolean),
					examination: clinicalNote.assessment?.trim() ?? "",
					notes: clinicalNote.plan?.trim() ?? "",
					patient_hospital_no: record.hospital_no.trim(),
					consultant: normalizePersonName(encounter.consultant),
					department: normalizePersonName(encounter.clinic),
					secret_id: secretId,
				});
			}
		}

		const uniqueConsultations = Array.from(uniqueConsultationMap.values());
		const consultationSecretIds = uniqueConsultations.map((consultation) => consultation.secret_id);
		const appointmentLookup = new Set<string>(mappedAppointment.map((appointment) => appointment.secret_id));
		for (const secretIdBatch of chunkArray(consultationSecretIds, 4000)) {
			const appointmentDocs = await appointmentRecords.find(
				{ secret_id: { $in: secretIdBatch } },
				{ projection: { secret_id: 1 } },
			).toArray();
			for (const appointment of appointmentDocs) {
				if (appointment.secret_id) {
					appointmentLookup.add(appointment.secret_id);
				}
			}
		}

		console.log(`Mapping ${uniqueConsultations.length} records into consultations...`);
		const mappedConsultation: consultationRecord[] = [];
		let skippedConsultationsForMissingPatient = 0;
		for (const [index, consultation] of uniqueConsultations.entries()) {
			const { email } = createStaff(consultation.consultant, 0);
			const consultantId = staffLookup.get(email);
			const department = clinicLookup.get(normalizePersonName(consultation.department).toLowerCase());
			const patientId = patientLookup.get(consultation.patient_hospital_no);
			const appointmentExists = appointmentLookup.has(consultation.secret_id);

			if (!appointmentExists) {
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
				department_route: department?.route,
				appointment: consultation.secret_id,
			});

			if ((index + 1) % 1000 === 0) {
				console.log(`Mapped ${index + 1}/${uniqueConsultations.length} consultation records...`);
			}
		}
		console.log(`Consultations skipped for missing patient: ${skippedConsultationsForMissingPatient}`);

		console.log(`Importing ${mappedConsultation.length} records into ${dbName}.${'consultations'}...`);
		const consultationOperations: AnyBulkWriteOperation<consultationRecord>[] = [];
		for (const consultation of mappedConsultation) {
			consultationOperations.push({
				updateOne: {
					filter: { appointment: consultation.appointment },
					update: { $setOnInsert: consultation },
					upsert: true,
				},
			});
		}
		await insertInBatches<AnyBulkWriteOperation<consultationRecord>>(consultationOperations, async (batch) => {
			await consultations.bulkWrite(batch, { ordered: false });
		}, batchSize);

		console.log(`Imported ${mappedConsultation.length} records into ${dbName}.${collectionName}`);
	} finally {
		await client.close();
	}
}

void main().catch((error: unknown) => {
	console.error("Import failed:", error);
	process.exit(1);
});
