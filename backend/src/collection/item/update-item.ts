import { Result, None, Err, Ok } from "ts-results";
import { ItemRepository, ItemFieldRepositories } from ".";
import { CollectionFieldRepository, CollectionRepository } from "..";
import { UserRepository } from "../../user";
import { Failure, BadRequestFailure } from "../../utils/failure";
import { AuthorizeCollectionUpdate } from "../update-collection";
import { CheckAllFieldsSpecified, SetFieldsUseCase } from "./create-item";

type UpdateItemRequest = {
	id: string;
	name: string;
	tags: Set<string>;
	numberFields: Map<CollectionFieldId, number>;
	textFields: Map<CollectionFieldId, string>;
	multilineTextFields: Map<CollectionFieldId, string>;
	checkboxFields: Map<CollectionFieldId, boolean>;
	dateFields: Map<CollectionFieldId, Date>;
};

type CollectionFieldId = string;

export class UpdateItemUseCase {
	userRepository: UserRepository;
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
		this.collectionFieldRepository = collectionFieldRepository;
		this.itemRepository = itemRepository;
		this.itemFieldRepositories = itemFieldRepositories;
		this.authorizeCollectionUpdate = new AuthorizeCollectionUpdate(
			collectionRepository,
			userRepository,
		);
	}

	async execute(
		request: UpdateItemRequest,
		requesterId: string,
	): Promise<Result<None, Failure>> {
		const itemResult = await this.itemRepository.get(request.id);
		if (itemResult.err) return itemResult;
		const { item } = itemResult.val;
		const collection = item.collection;

		const authorizeResult = await this.authorizeCollectionUpdate.execute(
			collection,
			requesterId,
		);
		if (authorizeResult.err) return authorizeResult;

		const collectionFieldsResult =
			await this.collectionFieldRepository.getByCollection(collection.id);
		if (collectionFieldsResult.err) throw Error();
		const collectionFields = collectionFieldsResult.val;

		const updatedItem = structuredClone(item);
		updatedItem.name = request.name;
		updatedItem.tags = request.tags;

		const updateItemResult = await this.itemRepository.update(
			item.id,
			updatedItem,
		);
		if (updateItemResult.err) return updateItemResult;

		const setFields = new SetFieldsUseCase(
			request,
			item,
			this.itemFieldRepositories,
		);
		const setFieldsResult = await setFields.execute();
		if (setFieldsResult.err) return setFieldsResult;

		return Ok(None);
	}
}
