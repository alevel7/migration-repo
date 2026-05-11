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
	consultant: string;
	department: string;
	patient: string;
	department_route: string;
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
	department_route: string;
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

	const uniqueStaffs = Array.from(new Set(allStaffs.map((name) => name.toLowerCase()))).map(
		(lowerName) => allStaffs.find((name) => name.toLowerCase() === lowerName) ?? lowerName,
	);
	const uniqueClinics = Array.from(new Set(allClinics.map((name) => name.toLowerCase()))).map(
		(lowerName) => allClinics.find((name) => name.toLowerCase() === lowerName) ?? lowerName,
	);

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

		// create new appointment records
		const allAppointments = sourceRecords.flatMap((record) =>
			record.encounters.map((encounter) => ({
				appointment_time: encounter.appointment_date,
				consultant: normalizePersonName(encounter.consultant),
				department: normalizePersonName(encounter.clinic),
				patient_hospital_no: record.hospital_no.trim(),
				secret_id: encounter.appointment_id.trim(),
			})),
		);

		const uniqueAppointments = Array.from(
			new Map(allAppointments.map((appointment) => [appointment.secret_id, appointment])).values(),
		);

		console.log(`Mapping ${uniqueAppointments.length} records into...`);
		const mappedAppointment: appointmentRecord[] = [];
		for (const appointment of uniqueAppointments) {
			const { email } = createStaff(appointment.consultant, 0);
			const consultant = await staffs.findOne({
				email,
			});

			const { name } = createClinic(appointment.department, 0);
			const department = await clinics.findOne({
				name,
			});

			const patient = await patients.findOne({
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
				consultant: consultant._id?.toString(),
				department: department._id?.toString(),
				patient: patient._id?.toString(),
				department_route: department.route,
				secret_id: appointment.secret_id,
			});
		}

		console.log(`Importing ${uniqueAppointments.length} records into ${dbName}.${'appointmentRecords'}...`);
		const appointmentOperations: AnyBulkWriteOperation<appointmentRecord>[] = [];
		for (const appointment of mappedAppointment) {
			appointmentOperations.push({
				updateOne: {
					filter: { secret_id: appointment.secret_id },
					update: { $setOnInsert: appointment },
					upsert: true,
				},
			});
		}
		await insertInBatches<AnyBulkWriteOperation<appointmentRecord>>(appointmentOperations, async (batch) => {
			await appointmentRecords.bulkWrite(batch, { ordered: false });
		}, batchSize);
		console.log(`Imported ${mappedAppointment.length} records into ${dbName}.${'appointmentRecords'}`);

		// create new consultations records
		const allConsultations = sourceRecords.flatMap((record) =>
			record.encounters.map((encounter) => {
				const clinicalNote = encounter.clinical_notes?.[0];

				if (!clinicalNote) {
					throw new Error(`Missing clinical notes for appointment ID: ${encounter.appointment_id}`);
				}

				return {
					complaintII: clinicalNote.chief_complaint?.trim() ?? "",
					complaint_history: clinicalNote.history?.trim() ?? "",
					uncoded_diagnosis: [clinicalNote.diagnosis?.trim() ?? ""].filter(Boolean),
					examination: clinicalNote.assessment?.trim() ?? "",
					notes: clinicalNote.plan?.trim() ?? "",
					patient_hospital_no: record.hospital_no.trim(),
					consultant: normalizePersonName(encounter.consultant),
					department: normalizePersonName(encounter.clinic),
					secret_id: encounter.appointment_id.trim(),
				};
			}),
		);

		const uniqueConsultations = Array.from(
			new Map(allConsultations.map((consultation) => [consultation.secret_id, consultation])).values(),
		);

		console.log(`Mapping ${uniqueConsultations.length} records into...`);
		const mappedConsultation: consultationRecord[] = [];
		for (const consultation of uniqueConsultations) {
			const { email } = createStaff(consultation.consultant, 0);
			const consultant = await staffs.findOne({ email });

			const { name } = createClinic(consultation.department, 0);
			const department = await clinics.findOne({ name });

			const patient = await patients.findOne({
				$or: [
					{ hospital_number: consultation.patient_hospital_no },
					{ old_hospital_number: consultation.patient_hospital_no },
				],
			});

			const appointment = await appointmentRecords.findOne({ secret_id: consultation.secret_id });

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
				patient: patient._id?.toString(),
				department_route: department.route,
				appointment: appointment.secret_id,
			});
		}

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
