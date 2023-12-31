import { Result, None, Ok, Err } from "ts-results";
import {
	Collection,
	CollectionRepository,
	CollectionFieldType,
	CollectionField,
	CollectionFieldRepository,
	collectionFieldTypes,
} from "..";
import { UserRepository } from "../../user";
import { BadRequestFailure, Failure } from "../../utils/failure";
import { AuthorizeCollectionUpdate } from "../update-collection";
import { nanoid } from "nanoid";
import {
	Item,
	ItemRepository,
	generateItemFieldId,
	ItemFieldRepositories,
} from ".";
import { areArraysEqual } from "../../utils/array";
import { KeyValueRepository } from "../../utils/key-value";

function generateItemId(): string {
	return nanoid();
}

function createNewItem({
	name,
	tags,
	collection,
}: {
	name: string;
	tags: Set<string>;
	collection: Collection;
}): Item {
	return {
		name,
		tags,
		collection,
		id: generateItemId(),
		createdAt: new Date(),
	};
}

type CreateItemRequest = {
	collectionId: string;
	name: string;
	tags: Set<string>;
	numberFields: Map<CollectionFieldId, number>;
	textFields: Map<CollectionFieldId, string>;
	multilineTextFields: Map<CollectionFieldId, string>;
	checkboxFields: Map<CollectionFieldId, boolean>;
	dateFields: Map<CollectionFieldId, Date>;
};

type CollectionFieldId = string;

export class CreateItemUseCase {
	userRepository: UserRepository;
	collectionRepository: CollectionRepository;
	collectionFieldRepository: CollectionFieldRepository;
	itemRepository: ItemRepository;
	authorizeCollectionUpdate: AuthorizeCollectionUpdate;
	itemFieldRepositories: ItemFieldRepositories;

	constructor(
		userRepository: UserRepository,
		collectionRepository: CollectionRepository,
		collectionFieldRepository: CollectionFieldRepository,
		itemRepository: ItemRepository,
		itemFieldRepositories: ItemFieldRepositories,
	) {
		this.userRepository = userRepository;
		this.collectionRepository = collectionRepository;
		this.collectionFieldRepository = collectionFieldRepository;
		this.itemRepository = itemRepository;
		this.authorizeCollectionUpdate = new AuthorizeCollectionUpdate(
			collectionRepository,
			userRepository,
		);
		this.itemFieldRepositories = itemFieldRepositories;
	}

	async execute(
		request: CreateItemRequest,
		requesterId: string,
	): Promise<Result<string, Failure>> {
		const collectionResult = await this.collectionRepository.get(
			request.collectionId,
			{ include: { fields: true } },
		);
		if (collectionResult.err) return collectionResult;
		const { collection, fields: collectionFields } = collectionResult.val;

		const authorizeResult = await this.authorizeCollectionUpdate.execute(
			collection,
			requesterId,
		);
		if (authorizeResult.err) return authorizeResult;

		const checkAllFieldsSpecified = new CheckAllFieldsSpecified(
			request,
			collectionFields,
		);
		const allFieldsSpecified = await checkAllFieldsSpecified.execute();
		if (!allFieldsSpecified) return Err(new BadRequestFailure());

		const item: Item = createNewItem({
			collection,
			name: request.name,
			tags: request.tags,
		});

		const createItemResult = await this.itemRepository.create(item);
		if (createItemResult.err) return createItemResult;

		const setFields = new SetFieldsUseCase(
			request,
			item,
			this.itemFieldRepositories,
		);
		const setFieldsResult = await setFields.execute();
		if (setFieldsResult.err) return setFieldsResult;

		return Ok(item.id);
	}
}

type SetFieldsRequest = {
	numberFields: Map<CollectionFieldId, number>;
	textFields: Map<CollectionFieldId, string>;
	multilineTextFields: Map<CollectionFieldId, string>;
	checkboxFields: Map<CollectionFieldId, boolean>;
	dateFields: Map<CollectionFieldId, Date>;
};

export class SetFieldsUseCase {
	request: SetFieldsRequest;
	item: Item;
	itemFieldRepositories: ItemFieldRepositories;

	constructor(
		request: SetFieldsRequest,
		item: Item,
		itemFieldRepositories: ItemFieldRepositories,
	) {
		this.request = request;
		this.item = item;
		this.itemFieldRepositories = itemFieldRepositories;
	}

	async execute(): Promise<Result<None, Failure>> {
		const setFieldsFns = [
			() =>
				this.setFieldsOfType(
					this.request.numberFields,
					this.itemFieldRepositories.number,
				),
			() =>
				this.setFieldsOfType(
					this.request.textFields,
					this.itemFieldRepositories.text,
				),
			() =>
				this.setFieldsOfType(
					this.request.multilineTextFields,
					this.itemFieldRepositories.multilineText,
				),
			() =>
				this.setFieldsOfType(
					this.request.checkboxFields,
					this.itemFieldRepositories.checkbox,
				),
			() =>
				this.setFieldsOfType(
					this.request.dateFields,
					this.itemFieldRepositories.date,
				),
		];

		for (const setFields of setFieldsFns) {
			const result = await setFields();
			if (result.err) return result;
		}

		return Ok(None);
	}

	async setFieldsOfType<T>(
		requestFields: Map<string, T>,
		itemFieldRepository: KeyValueRepository<T>,
	): Promise<Result<None, Failure>> {
		const fields = new Map<string, T>();

		for (const [collectionFieldId, value] of requestFields) {
			const fieldId = generateItemFieldId(this.item.id, collectionFieldId);
			fields.set(fieldId, value);
		}
		const setManyResult = await itemFieldRepository.setMany(fields);
		if (setManyResult.err) return setManyResult;

		return Ok(None);
	}
}

type RequestFields = {
	numberFields: Map<CollectionFieldId, number>;
	textFields: Map<CollectionFieldId, string>;
	multilineTextFields: Map<CollectionFieldId, string>;
	checkboxFields: Map<CollectionFieldId, boolean>;
	dateFields: Map<CollectionFieldId, Date>;
};

export class CheckAllFieldsSpecified {
	request: RequestFields;
	allCollectionFields: CollectionField[];

	constructor(request: RequestFields, allCollectionFields: CollectionField[]) {
		this.request = request;
		this.allCollectionFields = allCollectionFields;
	}

	async execute(): Promise<boolean> {
		const eachType = collectionFieldTypes.map((type) => {
			return () => this.checkCollectionFieldsSpecified(type);
		});

		for (const checkSpecified of eachType) {
			const specified = checkSpecified();
			if (!specified) return false;
		}

		return true;
	}

	checkCollectionFieldsSpecified(type: CollectionFieldType): boolean {
		const collectionFields = this.allCollectionFields.filter(
			(f) => f.type === type,
		);
		const collectionFieldIds = collectionFields.map((f) => f.id);

		const requestFields = this.getRequestFieldsOfType(type);
		const requestFieldIds = [...requestFields.keys()];

		return areArraysEqual(collectionFieldIds, requestFieldIds);
	}

	getRequestFieldsOfType(type: CollectionFieldType): Map<string, any> {
		const map = {
			[CollectionFieldType.Number]: this.request.numberFields,
			[CollectionFieldType.Text]: this.request.textFields,
			[CollectionFieldType.MultilineText]: this.request.multilineTextFields,
			[CollectionFieldType.Checkbox]: this.request.checkboxFields,
			[CollectionFieldType.Date]: this.request.dateFields,
		};

		return map[type];
	}
}
