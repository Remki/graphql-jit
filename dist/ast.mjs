import {
  GraphQLError,
  GraphQLIncludeDirective,
  GraphQLSkipDirective,
  isEnumType,
  isInputObjectType,
  isListType,
  isNonNullType,
  isScalarType,
  print,
  typeFromAST,
  valueFromASTUntyped,
  Kind,
  isAbstractType
} from "graphql";
import { GLOBAL_VARIABLES_NAME } from "./execution.js";
import createInspect from "./inspect.js";
import { getGraphQLErrorOptions, resolveFieldDef } from "./compat.js";
const inspect = createInspect();
function collectFields(compilationContext, runtimeType, selectionSet, fields, visitedFragmentNames, parentResponsePath) {
  return collectFieldsImpl(
    compilationContext,
    runtimeType,
    selectionSet,
    fields,
    visitedFragmentNames,
    void 0,
    serializeObjectPathForSkipInclude(parentResponsePath)
  );
}
function collectFieldsImpl(compilationContext, runtimeType, selectionSet, fields, visitedFragmentNames, previousShouldInclude = [], parentResponsePath = "") {
  const stack = [];
  stack.push({
    selectionSet,
    parentResponsePath,
    previousShouldInclude
  });
  while (stack.length > 0) {
    const { selectionSet: selectionSet2, parentResponsePath: parentResponsePath2, previousShouldInclude: previousShouldInclude2 } = stack.pop();
    for (const selection of selectionSet2.selections) {
      switch (selection.kind) {
        case Kind.FIELD: {
          collectFieldsForField({
            compilationContext,
            fields,
            parentResponsePath: parentResponsePath2,
            previousShouldInclude: previousShouldInclude2,
            selection
          });
          break;
        }
        case Kind.INLINE_FRAGMENT: {
          if (!doesFragmentConditionMatch(
            compilationContext,
            selection,
            runtimeType
          )) {
            continue;
          }
          const compiledSkipInclude = compileSkipInclude(
            compilationContext,
            selection
          );
          stack.push({
            selectionSet: selection.selectionSet,
            parentResponsePath: parentResponsePath2,
            previousShouldInclude: joinShouldIncludeCompilations(
              // `should include`s from previous fragments
              previousShouldInclude2,
              // current fragment's shouldInclude
              [compiledSkipInclude]
            )
          });
          break;
        }
        case Kind.FRAGMENT_SPREAD: {
          const fragName = selection.name.value;
          if (visitedFragmentNames[fragName]) {
            continue;
          }
          visitedFragmentNames[fragName] = true;
          const fragment = compilationContext.fragments[fragName];
          if (!fragment || !doesFragmentConditionMatch(
            compilationContext,
            fragment,
            runtimeType
          )) {
            continue;
          }
          const compiledSkipInclude = compileSkipInclude(
            compilationContext,
            selection
          );
          stack.push({
            selectionSet: fragment.selectionSet,
            parentResponsePath: parentResponsePath2,
            previousShouldInclude: joinShouldIncludeCompilations(
              // `should include`s from previous fragments
              previousShouldInclude2,
              // current fragment's shouldInclude
              [compiledSkipInclude]
            )
          });
          break;
        }
      }
    }
  }
  return fields;
}
function collectFieldsForField({
  compilationContext,
  fields,
  parentResponsePath,
  previousShouldInclude,
  selection
}) {
  const name = getFieldEntryKey(selection);
  if (!fields[name]) {
    fields[name] = [];
  }
  const fieldNode = selection;
  const currentPath = joinSkipIncludePath(
    parentResponsePath,
    // use alias(instead of selection.name.value) if available as the responsePath used for lookup uses alias
    name
  );
  const compiledSkipInclude = compileSkipInclude(compilationContext, selection);
  if (compilationContext.options.useExperimentalPathBasedSkipInclude) {
    if (!fieldNode.__internalShouldIncludePath)
      fieldNode.__internalShouldIncludePath = {};
    fieldNode.__internalShouldIncludePath[currentPath] = joinShouldIncludeCompilations(
      fieldNode.__internalShouldIncludePath?.[currentPath] ?? [],
      previousShouldInclude,
      [compiledSkipInclude]
    );
  } else {
    fieldNode.__internalShouldInclude = joinShouldIncludeCompilations(
      fieldNode.__internalShouldInclude ?? [],
      previousShouldInclude,
      [compiledSkipInclude]
    );
  }
  augmentFieldNodeTree(compilationContext, fieldNode, currentPath);
  fields[name].push(fieldNode);
}
function augmentFieldNodeTree(compilationContext, rootFieldNode, parentResponsePath) {
  for (const selection of rootFieldNode.selectionSet?.selections ?? []) {
    const stack = [];
    stack.push({
      parentFieldNode: rootFieldNode,
      selection,
      comesFromFragmentSpread: false,
      parentResponsePath
    });
    while (stack.length > 0) {
      const {
        parentFieldNode,
        selection: selection2,
        comesFromFragmentSpread,
        parentResponsePath: parentResponsePath2
      } = stack.pop();
      switch (selection2.kind) {
        case Kind.FIELD: {
          const jitFieldNode = selection2;
          const currentPath = joinSkipIncludePath(
            parentResponsePath2,
            // use alias(instead of selection.name.value) if available as the responsePath used for lookup uses alias
            getFieldEntryKey(jitFieldNode)
          );
          if (!comesFromFragmentSpread) {
            if (compilationContext.options.useExperimentalPathBasedSkipInclude) {
              if (!jitFieldNode.__internalShouldIncludePath)
                jitFieldNode.__internalShouldIncludePath = {};
              jitFieldNode.__internalShouldIncludePath[currentPath] = joinShouldIncludeCompilations(
                parentFieldNode.__internalShouldIncludePath?.[parentResponsePath2] ?? [],
                jitFieldNode.__internalShouldIncludePath?.[currentPath] ?? []
              );
            } else {
              jitFieldNode.__internalShouldInclude = joinShouldIncludeCompilations(
                parentFieldNode.__internalShouldInclude ?? [],
                jitFieldNode.__internalShouldInclude ?? []
              );
            }
          }
          for (const selection3 of jitFieldNode.selectionSet?.selections ?? []) {
            stack.push({
              parentFieldNode: jitFieldNode,
              selection: selection3,
              comesFromFragmentSpread: false,
              parentResponsePath: currentPath
            });
          }
          break;
        }
        case Kind.INLINE_FRAGMENT: {
          for (const subSelection of selection2.selectionSet.selections) {
            stack.push({
              parentFieldNode,
              selection: subSelection,
              comesFromFragmentSpread: true,
              parentResponsePath: parentResponsePath2
            });
          }
          break;
        }
        case Kind.FRAGMENT_SPREAD: {
          const fragment = compilationContext.fragments[selection2.name.value];
          for (const subSelection of fragment.selectionSet.selections) {
            stack.push({
              parentFieldNode,
              selection: subSelection,
              comesFromFragmentSpread: true,
              parentResponsePath: parentResponsePath2
            });
          }
        }
      }
    }
  }
}
function joinShouldIncludeCompilations(...compilations) {
  const conditionsSet = /* @__PURE__ */ new Set();
  for (const conditions of compilations) {
    for (const condition of conditions) {
      if (condition !== "true") {
        conditionsSet.add(condition);
      }
    }
  }
  return Array.from(conditionsSet);
}
function compileSkipInclude(compilationContext, node) {
  if (node.directives == null || node.directives.length < 1) {
    return "true";
  }
  const { skipValue, includeValue } = compileSkipIncludeDirectiveValues(
    compilationContext,
    node
  );
  if (skipValue != null && includeValue != null) {
    return `${skipValue} === false && ${includeValue} === true`;
  } else if (skipValue != null) {
    return `(${skipValue} === false)`;
  } else if (includeValue != null) {
    return `(${includeValue} === true)`;
  } else {
    return `true`;
  }
}
function compileSkipIncludeDirectiveValues(compilationContext, node) {
  const skipDirective = node.directives?.find(
    (it) => it.name.value === GraphQLSkipDirective.name
  );
  const includeDirective = node.directives?.find(
    (it) => it.name.value === GraphQLIncludeDirective.name
  );
  const skipValue = skipDirective ? compileSkipIncludeDirective(compilationContext, skipDirective) : (
    // The null here indicates the absense of the directive
    // which is later used to determine if both skip and include
    // are present
    null
  );
  const includeValue = includeDirective ? compileSkipIncludeDirective(compilationContext, includeDirective) : (
    // The null here indicates the absense of the directive
    // which is later used to determine if both skip and include
    // are present
    null
  );
  return { skipValue, includeValue };
}
function compileSkipIncludeDirective(compilationContext, directive) {
  const ifNode = directive.arguments?.find((it) => it.name.value === "if");
  if (ifNode == null) {
    throw new GraphQLError(
      `Directive '${directive.name.value}' is missing required arguments: 'if'`,
      getGraphQLErrorOptions([directive])
    );
  }
  switch (ifNode.value.kind) {
    case Kind.VARIABLE:
      validateSkipIncludeVariableType(compilationContext, ifNode.value);
      return `${GLOBAL_VARIABLES_NAME}["${ifNode.value.name.value}"]`;
    case Kind.BOOLEAN:
      return `${ifNode.value.value.toString()}`;
    default:
      throw new GraphQLError(
        `Argument 'if' on Directive '${directive.name.value}' has an invalid value (${valueFromASTUntyped(
          ifNode.value
        )}). Expected type 'Boolean!'`,
        getGraphQLErrorOptions([ifNode])
      );
  }
}
function validateSkipIncludeVariableType(compilationContext, variable) {
  const variableDefinition = compilationContext.operation.variableDefinitions?.find(
    (it) => it.variable.name.value === variable.name.value
  );
  if (variableDefinition == null) {
    throw new GraphQLError(
      `Variable '${variable.name.value}' is not defined`,
      getGraphQLErrorOptions([variable])
    );
  }
  if (!// The variable defintion is a Non-nullable Boolean type
  (variableDefinition.type.kind === Kind.NON_NULL_TYPE && variableDefinition.type.type.kind === Kind.NAMED_TYPE && variableDefinition.type.type.name.value === "Boolean" || // or the variable definition is a nullable Boolean type with a default value
  variableDefinition.type.kind === Kind.NAMED_TYPE && variableDefinition.type.name.value === "Boolean" && variableDefinition.defaultValue != null)) {
    throw new GraphQLError(
      `Variable '${variable.name.value}' of type '${typeNodeToString(
        variableDefinition.type
      )}' used in position expecting type 'Boolean!'`,
      getGraphQLErrorOptions([variableDefinition])
    );
  }
}
function typeNodeToString(type) {
  switch (type.kind) {
    case Kind.NAMED_TYPE:
      return type.name.value;
    case Kind.NON_NULL_TYPE:
      return `${typeNodeToString(type.type)}!`;
    case Kind.LIST_TYPE:
      return `[${typeNodeToString(type.type)}]`;
  }
}
function doesFragmentConditionMatch(compilationContext, fragment, type) {
  const typeConditionNode = fragment.typeCondition;
  if (!typeConditionNode) {
    return true;
  }
  const conditionalType = typeFromAST(
    compilationContext.schema,
    typeConditionNode
  );
  if (conditionalType === type) {
    return true;
  }
  if (!conditionalType) {
    return false;
  }
  if (isAbstractType(conditionalType)) {
    return compilationContext.schema.isSubType(conditionalType, type);
  }
  return false;
}
function getFieldEntryKey(node) {
  return node.alias ? node.alias.value : node.name.value;
}
function collectSubfields(compilationContext, returnType, fieldNodes, parentResponsePath) {
  let subFieldNodes = /* @__PURE__ */ Object.create(null);
  const visitedFragmentNames = /* @__PURE__ */ Object.create(null);
  for (const fieldNode of fieldNodes) {
    const selectionSet = fieldNode.selectionSet;
    if (selectionSet) {
      subFieldNodes = collectFields(
        compilationContext,
        returnType,
        selectionSet,
        subFieldNodes,
        visitedFragmentNames,
        parentResponsePath
      );
    }
  }
  return subFieldNodes;
}
function getArgumentDefs(def, node) {
  const values = {};
  const missing = [];
  const argDefs = def.args;
  const argNodes = node.arguments || [];
  const argNodeMap = keyMap(argNodes, (arg) => arg.name.value);
  for (const argDef of argDefs) {
    const name = argDef.name;
    if (argDef.defaultValue !== void 0) {
      values[name] = argDef.defaultValue;
    }
    const argType = argDef.type;
    const argumentNode = argNodeMap[name];
    let hasVariables = false;
    if (argumentNode && argumentNode.value.kind === Kind.VARIABLE) {
      hasVariables = true;
      missing.push({
        valueNode: argumentNode.value,
        path: addPath(void 0, name, "literal"),
        argument: { definition: argDef, node: argumentNode }
      });
    } else if (argumentNode) {
      const coercedValue = valueFromAST(argumentNode.value, argType);
      if (coercedValue === void 0) {
        throw new GraphQLError(
          `Argument "${name}" of type "${argType}" has invalid value ${print(
            argumentNode.value
          )}.`,
          getGraphQLErrorOptions(argumentNode.value)
        );
      }
      if (isASTValueWithVariables(coercedValue)) {
        missing.push(
          ...coercedValue.variables.map(({ valueNode, path }) => ({
            valueNode,
            path: addPath(path, name, "literal")
          }))
        );
      }
      values[name] = coercedValue.value;
    }
    if (isNonNullType(argType) && values[name] === void 0 && !hasVariables) {
      throw new GraphQLError(
        argumentNode ? `Argument "${name}" of non-null type "${argType}" must not be null.` : `Argument "${name}" of required type "${argType}" was not provided.`,
        getGraphQLErrorOptions(node)
      );
    }
  }
  return { values, missing };
}
function isASTValueWithVariables(x) {
  return !!x.variables;
}
function valueFromAST(valueNode, type) {
  if (isNonNullType(type)) {
    if (valueNode.kind === Kind.NULL) {
      return;
    }
    return valueFromAST(valueNode, type.ofType);
  }
  if (valueNode.kind === Kind.NULL) {
    return {
      value: null
    };
  }
  if (valueNode.kind === Kind.VARIABLE) {
    return { value: null, variables: [{ valueNode, path: void 0 }] };
  }
  if (isListType(type)) {
    const itemType = type.ofType;
    if (valueNode.kind === Kind.LIST) {
      const coercedValues = [];
      const variables = [];
      const itemNodes = valueNode.values;
      for (let i = 0; i < itemNodes.length; i++) {
        const itemNode = itemNodes[i];
        if (itemNode.kind === Kind.VARIABLE) {
          coercedValues.push(null);
          variables.push({
            valueNode: itemNode,
            path: addPath(void 0, i.toString(), "literal")
          });
        } else {
          const itemValue = valueFromAST(itemNode, itemType);
          if (!itemValue) {
            return;
          }
          coercedValues.push(itemValue.value);
          if (isASTValueWithVariables(itemValue)) {
            variables.push(
              ...itemValue.variables.map(({ valueNode: valueNode2, path }) => ({
                valueNode: valueNode2,
                path: addPath(path, i.toString(), "literal")
              }))
            );
          }
        }
      }
      return { value: coercedValues, variables };
    }
    const coercedValue = valueFromAST(valueNode, itemType);
    if (coercedValue === void 0) {
      return;
    }
    if (isASTValueWithVariables(coercedValue)) {
      return {
        value: [coercedValue.value],
        variables: coercedValue.variables.map(({ valueNode: valueNode2, path }) => ({
          valueNode: valueNode2,
          path: addPath(path, "0", "literal")
        }))
      };
    }
    return { value: [coercedValue.value] };
  }
  if (isInputObjectType(type)) {
    if (valueNode.kind !== Kind.OBJECT) {
      return;
    }
    const coercedObj = /* @__PURE__ */ Object.create(null);
    const variables = [];
    const fieldNodes = keyMap(valueNode.fields, (field) => field.name.value);
    const fields = Object.values(type.getFields());
    for (const field of fields) {
      if (field.defaultValue !== void 0) {
        coercedObj[field.name] = field.defaultValue;
      }
      const fieldNode = fieldNodes[field.name];
      if (!fieldNode) {
        continue;
      }
      const fieldValue = valueFromAST(fieldNode.value, field.type);
      if (!fieldValue) {
        return;
      }
      if (isASTValueWithVariables(fieldValue)) {
        variables.push(
          ...fieldValue.variables.map(({ valueNode: valueNode2, path }) => ({
            valueNode: valueNode2,
            path: addPath(path, field.name, "literal")
          }))
        );
      }
      coercedObj[field.name] = fieldValue.value;
    }
    return { value: coercedObj, variables };
  }
  if (isEnumType(type)) {
    if (valueNode.kind !== Kind.ENUM) {
      return;
    }
    const enumValue = type.getValue(valueNode.value);
    if (!enumValue) {
      return;
    }
    return { value: enumValue.value };
  }
  if (isScalarType(type)) {
    let result;
    try {
      if (type.parseLiteral.length > 1) {
        console.error(
          "Scalar with variable inputs detected for parsing AST literals. This is not supported."
        );
      }
      result = type.parseLiteral(valueNode, {});
    } catch (error) {
      return;
    }
    if (isInvalid(result)) {
      return;
    }
    return { value: result };
  }
  throw new Error(`Unexpected input type: "${inspect(type)}".`);
}
function keyMap(list, keyFn) {
  return list.reduce(
    // eslint-disable-next-line no-sequences
    (map, item) => (map[keyFn(item)] = item, map),
    /* @__PURE__ */ Object.create(null)
  );
}
function computeLocations(nodes) {
  return nodes.reduce((list, node) => {
    if (node.loc) {
      list.push(getLocation(node.loc));
    }
    return list;
  }, []);
}
function getLocation(loc) {
  return {
    line: loc.startToken.line,
    column: loc.startToken.column
  };
}
function addPath(responsePath, key, type = "literal") {
  return { prev: responsePath, key, type };
}
function flattenPath(path) {
  const flattened = [];
  let curr = path;
  while (curr) {
    flattened.push({ key: curr.key, type: curr.type });
    curr = curr.prev;
  }
  return flattened;
}
function serializeObjectPathForSkipInclude(path) {
  let serialized = "";
  let curr = path;
  while (curr) {
    if (curr.type === "literal") {
      serialized = joinSkipIncludePath(curr.key, serialized);
    }
    curr = curr.prev;
  }
  return serialized;
}
function joinSkipIncludePath(a, b) {
  if (a) {
    if (b) {
      return `${a}.${b}`;
    }
    return a;
  }
  return b;
}
function isInvalid(value) {
  return value === void 0 || value !== value;
}
export {
  addPath,
  collectFields,
  collectSubfields,
  computeLocations,
  flattenPath,
  getArgumentDefs,
  joinSkipIncludePath,
  resolveFieldDef,
  serializeObjectPathForSkipInclude,
  valueFromAST
};
//# sourceMappingURL=ast.mjs.map