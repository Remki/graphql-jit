import {
  isAbstractType,
  isEnumType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType
} from "graphql";
import { collectFields, collectSubfields, resolveFieldDef } from "./ast.js";
import { getOperationRootType } from "./compat.js";
const PRIMITIVES = {
  Int: "integer",
  Float: "number",
  String: "string",
  Boolean: "boolean",
  ID: "string"
};
function queryToJSONSchema(compilationContext) {
  const type = getOperationRootType(
    compilationContext.schema,
    compilationContext.operation
  );
  const fields = collectFields(
    compilationContext,
    type,
    compilationContext.operation.selectionSet,
    /* @__PURE__ */ Object.create(null),
    /* @__PURE__ */ Object.create(null)
  );
  const fieldProperties = /* @__PURE__ */ Object.create(null);
  for (const responseName of Object.keys(fields)) {
    const fieldType = resolveFieldDef(
      compilationContext,
      type,
      fields[responseName]
    );
    if (!fieldType) {
      continue;
    }
    fieldProperties[responseName] = transformNode(
      compilationContext,
      fields[responseName],
      fieldType.type
    );
  }
  return {
    type: "object",
    properties: {
      data: {
        type: "object",
        properties: fieldProperties,
        nullable: true
      },
      errors: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
          properties: {
            message: {
              type: "string"
            },
            path: {
              type: "array",
              items: {
                type: ["string", "number"]
              }
            },
            locations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  line: {
                    type: "number"
                  },
                  column: {
                    type: "number"
                  }
                }
              }
            }
          }
        }
      }
    }
  };
}
function transformNode(compilationContext, fieldNodes, type) {
  if (isObjectType(type)) {
    const subfields = collectSubfields(compilationContext, type, fieldNodes);
    const properties = /* @__PURE__ */ Object.create(null);
    for (const responseName of Object.keys(subfields)) {
      const fieldType = resolveFieldDef(
        compilationContext,
        type,
        subfields[responseName]
      );
      if (!fieldType) {
        continue;
      }
      properties[responseName] = transformNode(
        compilationContext,
        subfields[responseName],
        fieldType.type
      );
    }
    return {
      type: "object",
      properties,
      nullable: true
    };
  }
  if (isListType(type)) {
    return {
      type: "array",
      items: transformNode(compilationContext, fieldNodes, type.ofType),
      nullable: true
    };
  }
  if (isNonNullType(type)) {
    const nullable = transformNode(compilationContext, fieldNodes, type.ofType);
    nullable.nullable = false;
    return nullable;
  }
  if (isEnumType(type)) {
    return {
      type: "string",
      nullable: true
    };
  }
  if (isScalarType(type)) {
    const jsonSchemaType = PRIMITIVES[type.name];
    if (!jsonSchemaType) {
      throw new Error(`Got unexpected PRIMITIVES type: ${type.name}`);
    }
    return {
      type: jsonSchemaType,
      nullable: true
    };
  }
  if (isAbstractType(type)) {
    return compilationContext.schema.getPossibleTypes(type).reduce(
      (res, t) => {
        const jsonSchema = transformNode(compilationContext, fieldNodes, t);
        res.properties = {
          ...res.properties,
          ...jsonSchema.properties
        };
        return res;
      },
      {
        type: "object",
        properties: {},
        nullable: true
      }
    );
  }
  throw new Error(`Got unhandled type: ${type.name}`);
}
export {
  queryToJSONSchema
};
//# sourceMappingURL=json.mjs.map