import fastJson from "fast-json-stringify";
import { genFn } from "./generate";
import {
  GraphQLEnumType,
  GraphQLError,
  isAbstractType,
  isLeafType,
  isListType,
  isNonNullType,
  isObjectType,
  isSpecifiedScalarType,
  Kind,
  locatedError,
  TypeNameMetaFieldDef
} from "graphql";
import { pathToArray } from "graphql/jsutils/Path.js";
import {
  addPath,
  collectFields,
  collectSubfields,
  computeLocations,
  flattenPath,
  getArgumentDefs,
  joinSkipIncludePath,
  resolveFieldDef,
  serializeObjectPathForSkipInclude
} from "./ast.js";
import { GraphQLError as GraphqlJitError } from "./error.js";
import createInspect from "./inspect.js";
import { queryToJSONSchema } from "./json.js";
import { createNullTrimmer } from "./non-null.js";
import {
  createResolveInfoThunk
} from "./resolve-info.js";
import {
  compileVariableParsing,
  failToParseVariables
} from "./variables.js";
import { getGraphQLErrorOptions, getOperationRootType } from "./compat.js";
const inspect = createInspect();
const joinOriginPaths = joinOriginPathsImpl;
const SAFETY_CHECK_PREFIX = "__validNode";
const GLOBAL_DATA_NAME = "__context.data";
const GLOBAL_ERRORS_NAME = "__context.errors";
const GLOBAL_NULL_ERRORS_NAME = "__context.nullErrors";
const GLOBAL_ROOT_NAME = "__context.rootValue";
const GLOBAL_VARIABLES_NAME = "__context.variables";
const GLOBAL_CONTEXT_NAME = "__context.context";
const GLOBAL_EXECUTION_CONTEXT = "__context";
const GLOBAL_PROMISE_COUNTER = "__context.promiseCounter";
const GLOBAL_INSPECT_NAME = "__context.inspect";
const GLOBAL_SAFE_MAP_NAME = "__context.safeMap";
const GRAPHQL_ERROR = "__context.GraphQLError";
const GLOBAL_RESOLVE = "__context.resolve";
const GLOBAL_PARENT_NAME = "__parent";
const LOCAL_JS_FIELD_NAME_PREFIX = "__field";
function compileQuery(schema, document, operationName, partialOptions) {
  if (!schema) {
    throw new Error(`Expected ${schema} to be a GraphQL schema.`);
  }
  if (!document) {
    throw new Error("Must provide document.");
  }
  if (partialOptions && partialOptions.resolverInfoEnricher && typeof partialOptions.resolverInfoEnricher !== "function") {
    throw new Error("resolverInfoEnricher must be a function");
  }
  try {
    const options = {
      disablingCapturingStackErrors: false,
      customJSONSerializer: false,
      disableLeafSerialization: false,
      customSerializers: {},
      useExperimentalPathBasedSkipInclude: false,
      ...partialOptions
    };
    const context = buildCompilationContext(
      schema,
      document,
      options,
      operationName
    );
    let stringify;
    if (options.customJSONSerializer) {
      const jsonSchema = queryToJSONSchema(context);
      stringify = fastJson(jsonSchema);
    } else {
      stringify = JSON.stringify;
    }
    const getVariables = compileVariableParsing(
      schema,
      context.operation.variableDefinitions || []
    );
    const type = getOperationRootType(context.schema, context.operation);
    const fieldMap = collectFields(
      context,
      type,
      context.operation.selectionSet,
      /* @__PURE__ */ Object.create(null),
      /* @__PURE__ */ Object.create(null)
    );
    const functionBody = compileOperation(context, type, fieldMap);
    const compiledQuery = {
      query: createBoundQuery(
        context,
        document,
        // eslint-disable-next-line no-new-func
        new Function("return " + functionBody)(),
        getVariables,
        context.operation.name != null ? context.operation.name.value : void 0
      ),
      stringify
    };
    if (context.operation.operation === "subscription") {
      compiledQuery.subscribe = createBoundSubscribe(
        context,
        document,
        compileSubscriptionOperation(
          context,
          type,
          fieldMap,
          compiledQuery.query
        ),
        getVariables,
        context.operation.name != null ? context.operation.name.value : void 0
      );
    }
    if (options.debug) {
      compiledQuery.__DO_NOT_USE_THIS_OR_YOU_WILL_BE_FIRED_compilation = functionBody;
    }
    return compiledQuery;
  } catch (err) {
    return {
      errors: normalizeErrors(err)
    };
  }
}
function isCompiledQuery(query) {
  return "query" in query && typeof query.query === "function";
}
function createBoundQuery(compilationContext, document, func, getVariableValues, operationName) {
  const { resolvers, typeResolvers, isTypeOfs, serializers, resolveInfos } = compilationContext;
  const trimmer = createNullTrimmer(compilationContext);
  const fnName = operationName || "query";
  const ret = {
    [fnName](rootValue, context, variables) {
      const parsedVariables = getVariableValues(variables || {});
      if (failToParseVariables(parsedVariables)) {
        return { errors: parsedVariables.errors };
      }
      const executionContext = {
        rootValue,
        context,
        variables: parsedVariables.coerced,
        safeMap,
        inspect,
        GraphQLError: GraphqlJitError,
        resolvers,
        typeResolvers,
        isTypeOfs,
        serializers,
        resolveInfos,
        trimmer,
        promiseCounter: 0,
        data: {},
        nullErrors: [],
        errors: []
      };
      const result = func.call(null, executionContext);
      if (isPromise(result)) {
        return result.then(postProcessResult);
      }
      return postProcessResult(executionContext);
    }
  };
  return ret[fnName];
}
function postProcessResult({
  data,
  nullErrors,
  errors,
  trimmer
}) {
  if (nullErrors.length > 0) {
    const trimmed = trimmer(data, nullErrors);
    return {
      data: trimmed.data,
      errors: errors.concat(trimmed.errors)
    };
  } else if (errors.length > 0) {
    return {
      data,
      errors
    };
  }
  return { data };
}
function compileOperation(context, type, fieldMap) {
  const serialExecution = context.operation.operation === "mutation";
  const topLevel = compileObjectType(
    context,
    type,
    [],
    [GLOBAL_ROOT_NAME],
    [GLOBAL_DATA_NAME],
    void 0,
    GLOBAL_ERRORS_NAME,
    fieldMap,
    true
  );
  let body = `function query (${GLOBAL_EXECUTION_CONTEXT}) {
  "use strict";
`;
  if (serialExecution) {
    body += `${GLOBAL_EXECUTION_CONTEXT}.queue = [];`;
  }
  body += generateUniqueDeclarations(context, true);
  body += `${GLOBAL_DATA_NAME} = ${topLevel}
`;
  if (serialExecution) {
    body += compileDeferredFieldsSerially(context);
    body += `
    ${GLOBAL_EXECUTION_CONTEXT}.finalResolve = () => {};
    ${GLOBAL_RESOLVE} = (context) => {
      if (context.jobCounter >= context.queue.length) {
        // All mutations have finished
        context.finalResolve(context);
        return;
      }
      context.queue[context.jobCounter++](context);
    };
    // There might not be a job to run due to invalid queries
    if (${GLOBAL_EXECUTION_CONTEXT}.queue.length > 0) {
      ${GLOBAL_EXECUTION_CONTEXT}.jobCounter = 1; // since the first one will be run manually
      ${GLOBAL_EXECUTION_CONTEXT}.queue[0](${GLOBAL_EXECUTION_CONTEXT});
    }
    // Promises have been scheduled so a new promise is returned
    // that will be resolved once every promise is done
    if (${GLOBAL_PROMISE_COUNTER} > 0) {
      return new Promise(resolve => ${GLOBAL_EXECUTION_CONTEXT}.finalResolve = resolve);
    }
  `;
  } else {
    body += compileDeferredFields(context);
    body += `
    // Promises have been scheduled so a new promise is returned
    // that will be resolved once every promise is done
    if (${GLOBAL_PROMISE_COUNTER} > 0) {
      return new Promise(resolve => ${GLOBAL_RESOLVE} = resolve);
    }`;
  }
  body += `
  // sync execution, the results are ready
  return undefined;
  }`;
  body += context.hoistedFunctions.join("\n");
  return body;
}
function compileDeferredFields(context) {
  let body = "";
  context.deferred.forEach((deferredField, index) => {
    body += `
      if (${SAFETY_CHECK_PREFIX}${index}) {
        ${compileDeferredField(context, deferredField)}
      }`;
  });
  return body;
}
function compileDeferredField(context, deferredField, appendix) {
  const {
    name,
    originPathsFormatted,
    destinationPaths,
    fieldNodes,
    fieldType,
    fieldName,
    jsFieldName,
    responsePath,
    parentType,
    args
  } = deferredField;
  const subContext = createSubCompilationContext(context);
  const nodeBody = compileType(
    subContext,
    parentType,
    fieldType,
    fieldNodes,
    [jsFieldName],
    [`${GLOBAL_PARENT_NAME}.${name}`],
    responsePath
  );
  const parentIndexes = getParentArgIndexes(context);
  const resolverName = getResolverName(parentType.name, fieldName);
  const resolverHandler = getHoistedFunctionName(
    context,
    `${name}${resolverName}Handler`
  );
  const topLevelArgs = getArgumentsName(resolverName);
  const validArgs = getValidArgumentsVarName(resolverName);
  const executionError = createErrorObject(
    context,
    fieldNodes,
    responsePath,
    "err.message != null ? err.message : err",
    "err"
  );
  const executionInfo = getExecutionInfo(
    subContext,
    parentType,
    fieldType,
    fieldName,
    fieldNodes,
    responsePath
  );
  const emptyError = createErrorObject(context, fieldNodes, responsePath, '""');
  const resolverParentPath = originPathsFormatted;
  const resolverCall = `${GLOBAL_EXECUTION_CONTEXT}.resolvers.${resolverName}(
          ${resolverParentPath},${topLevelArgs},${GLOBAL_CONTEXT_NAME}, ${executionInfo})`;
  const resultParentPath = destinationPaths.join(".");
  const compiledArgs = compileArguments(
    subContext,
    args,
    topLevelArgs,
    validArgs,
    fieldType,
    responsePath
  );
  const body = `
    ${compiledArgs}
    if (${validArgs} === true) {
      var __value = null;
      try {
        __value = ${resolverCall};
      } catch (err) {
        ${getErrorDestination(fieldType)}.push(${executionError});
      }
      if (${isPromiseInliner("__value")}) {
      ${promiseStarted()}
       __value.then(result => {
        ${resolverHandler}(${GLOBAL_EXECUTION_CONTEXT}, ${resultParentPath}, result, ${parentIndexes});
        ${promiseDone()}
       }, err => {
        if (err) {
          ${getErrorDestination(fieldType)}.push(${executionError});
        } else {
          ${getErrorDestination(fieldType)}.push(${emptyError});
        }
        ${promiseDone()}
       });
      } else {
        ${resolverHandler}(${GLOBAL_EXECUTION_CONTEXT}, ${resultParentPath}, __value, ${parentIndexes});
      }
    }`;
  context.hoistedFunctions.push(`
    function ${resolverHandler}(${GLOBAL_EXECUTION_CONTEXT}, ${GLOBAL_PARENT_NAME}, ${jsFieldName}, ${parentIndexes}) {
      ${generateUniqueDeclarations(subContext)}
      ${GLOBAL_PARENT_NAME}.${name} = ${nodeBody};
      ${compileDeferredFields(subContext)}
      ${appendix || ""}
    }
  `);
  return body;
}
function compileDeferredFieldsSerially(context) {
  let body = "";
  context.deferred.forEach((deferredField, index) => {
    const { name, fieldName, parentType } = deferredField;
    const resolverName = getResolverName(parentType.name, fieldName);
    const mutationHandler = getHoistedFunctionName(
      context,
      `${name}${resolverName}Mutation`
    );
    body += `
      if (${SAFETY_CHECK_PREFIX}${index}) {
        ${GLOBAL_EXECUTION_CONTEXT}.queue.push(${mutationHandler});
      }
    `;
    const appendix = `
    if (${GLOBAL_PROMISE_COUNTER} === 0) {
      ${GLOBAL_RESOLVE}(${GLOBAL_EXECUTION_CONTEXT});
    }
    `;
    context.hoistedFunctions.push(`
      function ${mutationHandler}(${GLOBAL_EXECUTION_CONTEXT}) {
        ${compileDeferredField(context, deferredField, appendix)}
      }
      `);
  });
  return body;
}
function compileType(context, parentType, type, fieldNodes, originPaths, destinationPaths, previousPath) {
  const sourcePath = joinOriginPaths(originPaths);
  let body = `${sourcePath} == null ? `;
  let errorDestination;
  if (isNonNullType(type)) {
    type = type.ofType;
    const nullErrorStr = `"Cannot return null for non-nullable field ${parentType.name}.${getFieldNodesName(fieldNodes)}."`;
    body += `(${GLOBAL_NULL_ERRORS_NAME}.push(${createErrorObject(
      context,
      fieldNodes,
      previousPath,
      nullErrorStr
    )}), null) :`;
    errorDestination = GLOBAL_NULL_ERRORS_NAME;
  } else {
    body += "null : ";
    errorDestination = GLOBAL_ERRORS_NAME;
  }
  body += "(";
  const errorPath = `${sourcePath}.message != null ? ${sourcePath}.message : ${sourcePath}`;
  body += `${sourcePath} instanceof Error ? (${errorDestination}.push(${createErrorObject(
    context,
    fieldNodes,
    previousPath,
    errorPath,
    sourcePath
  )}), null) : `;
  if (isLeafType(type)) {
    body += compileLeafType(
      context,
      type,
      originPaths,
      fieldNodes,
      previousPath,
      errorDestination
    );
  } else if (isObjectType(type)) {
    const fieldMap = collectSubfields(context, type, fieldNodes, previousPath);
    body += compileObjectType(
      context,
      type,
      fieldNodes,
      originPaths,
      destinationPaths,
      previousPath,
      errorDestination,
      fieldMap,
      false
    );
  } else if (isAbstractType(type)) {
    body += compileAbstractType(
      context,
      parentType,
      type,
      fieldNodes,
      originPaths,
      previousPath,
      errorDestination
    );
  } else if (isListType(type)) {
    body += compileListType(
      context,
      parentType,
      type,
      fieldNodes,
      originPaths,
      previousPath,
      errorDestination
    );
  } else {
    throw new Error(`unsupported type: ${type.toString()}`);
  }
  body += ")";
  return body;
}
function compileLeafType(context, type, originPaths, fieldNodes, previousPath, errorDestination) {
  let body = "";
  if (context.options.disableLeafSerialization && (type instanceof GraphQLEnumType || isSpecifiedScalarType(type))) {
    body += `${joinOriginPaths(originPaths)}`;
  } else {
    const serializerName = getSerializerName(type.name);
    context.serializers[serializerName] = getSerializer(
      type,
      context.options.customSerializers[type.name]
    );
    const parentIndexes = getParentArgIndexes(context);
    const serializerErrorHandler = getHoistedFunctionName(
      context,
      `${type.name}${originPaths.join("")}SerializerErrorHandler`
    );
    context.hoistedFunctions.push(`
    function ${serializerErrorHandler}(${GLOBAL_EXECUTION_CONTEXT}, message, ${parentIndexes}) {
    ${errorDestination}.push(${createErrorObject(
      context,
      fieldNodes,
      previousPath,
      "message"
    )});}
    `);
    body += `${GLOBAL_EXECUTION_CONTEXT}.serializers.${serializerName}(${GLOBAL_EXECUTION_CONTEXT}, ${joinOriginPaths(
      originPaths
    )}, ${serializerErrorHandler}, ${parentIndexes})`;
  }
  return body;
}
function compileObjectType(context, type, fieldNodes, originPaths, destinationPaths, responsePath, errorDestination, fieldMap, alwaysDefer) {
  const body = genFn();
  body("(");
  if (typeof type.isTypeOf === "function" && !alwaysDefer) {
    context.isTypeOfs[type.name + "IsTypeOf"] = type.isTypeOf;
    body(
      `!${GLOBAL_EXECUTION_CONTEXT}.isTypeOfs["${type.name}IsTypeOf"](${joinOriginPaths(
        originPaths
      )}) ? (${errorDestination}.push(${createErrorObject(
        context,
        fieldNodes,
        responsePath,
        `\`Expected value of type "${type.name}" but got: \${${GLOBAL_INSPECT_NAME}(${joinOriginPaths(
          originPaths
        )})}.\``
      )}), null) :`
    );
  }
  body("{");
  for (const name of Object.keys(fieldMap)) {
    const fieldNodes2 = fieldMap[name];
    const field = resolveFieldDef(context, type, fieldNodes2);
    if (!field) {
      continue;
    }
    body(`"${name}": `);
    const serializedResponsePath = joinSkipIncludePath(
      serializeObjectPathForSkipInclude(responsePath),
      name
    );
    const fieldConditionsList = (context.options.useExperimentalPathBasedSkipInclude ? fieldNodes2.map(
      (it) => it.__internalShouldIncludePath?.[serializedResponsePath]
    ) : fieldNodes2.map((it) => it.__internalShouldInclude)).filter(isNotNull);
    let fieldCondition = fieldConditionsList.map((it) => {
      if (it.length > 0) {
        return `(${it.join(" && ")})`;
      }
      return "true";
    }).filter(isNotNull).join(" || ");
    if (!fieldCondition) {
      fieldCondition = "true";
    }
    body(`
      (
        ${fieldCondition}
      )
    `);
    if (field === TypeNameMetaFieldDef) {
      body(`? "${type.name}" : undefined,`);
      continue;
    }
    let resolver = field.resolve;
    if (!resolver && alwaysDefer) {
      const fieldName = field.name;
      resolver = (parent) => parent && parent[fieldName];
    }
    if (resolver) {
      context.deferred.push({
        name,
        responsePath: addPath(responsePath, name),
        originPaths,
        originPathsFormatted: joinOriginPaths(originPaths),
        destinationPaths,
        parentType: type,
        fieldName: field.name,
        jsFieldName: getJsFieldName(field.name),
        fieldType: field.type,
        fieldNodes: fieldNodes2,
        args: getArgumentDefs(field, fieldNodes2[0])
      });
      context.resolvers[getResolverName(type.name, field.name)] = resolver;
      body(
        `
          ? (
              ${SAFETY_CHECK_PREFIX}${context.deferred.length - 1} = true,
              null
            )
          : (
              ${SAFETY_CHECK_PREFIX}${context.deferred.length - 1} = false,
              undefined
            )
        `
      );
    } else {
      body("?");
      body(
        compileType(
          context,
          type,
          field.type,
          fieldNodes2,
          originPaths.concat(field.name),
          destinationPaths.concat(name),
          addPath(responsePath, name)
        )
      );
      body(": undefined");
    }
    body(",");
  }
  body("}");
  body(")");
  return body.toString();
}
function compileAbstractType(context, parentType, type, fieldNodes, originPaths, previousPath, errorDestination) {
  let resolveType;
  if (type.resolveType) {
    resolveType = type.resolveType;
  } else {
    resolveType = (value, context2, info) => defaultResolveTypeFn(value, context2, info, type);
  }
  const typeResolverName = getTypeResolverName(type.name);
  context.typeResolvers[typeResolverName] = resolveType;
  const collectedTypes = context.schema.getPossibleTypes(type).map((objectType) => {
    const subContext = createSubCompilationContext(context);
    const object = compileType(
      subContext,
      parentType,
      objectType,
      fieldNodes,
      originPaths,
      ["__concrete"],
      addPath(previousPath, objectType.name, "meta")
    );
    return `case "${objectType.name}": {
                  ${generateUniqueDeclarations(subContext)}
                  const __concrete = ${object};
                  ${compileDeferredFields(subContext)}
                  return __concrete;
              }`;
  }).join("\n");
  const finalTypeName = "finalType";
  const nullTypeError = `"Runtime Object type is not a possible type for \\"${type.name}\\"."`;
  const notPossibleTypeError = (
    // eslint-disable-next-line no-template-curly-in-string
    '`Runtime Object type "${nodeType}" is not a possible type for "' + type.name + '".`'
  );
  const noTypeError = `${finalTypeName} ? ${notPossibleTypeError} : "Abstract type ${type.name} must resolve to an Object type at runtime for field ${parentType.name}.${getFieldNodesName(fieldNodes)}. Either the ${type.name} type should provide a \\"resolveType\\" function or each possible types should provide an \\"isTypeOf\\" function."`;
  return `((nodeType, err) =>
  {
    if (err != null) {
      ${errorDestination}.push(${createErrorObject(
    context,
    fieldNodes,
    previousPath,
    "err.message != null ? err.message : err",
    "err"
  )});
      return null;
    }
    if (nodeType == null) {
      ${errorDestination}.push(${createErrorObject(
    context,
    fieldNodes,
    previousPath,
    nullTypeError
  )})
      return null;
    }
    const ${finalTypeName} = typeof nodeType === "string" ? nodeType : nodeType.name;
    switch(${finalTypeName}) {
      ${collectedTypes}
      default:
      ${errorDestination}.push(${createErrorObject(
    context,
    fieldNodes,
    previousPath,
    noTypeError
  )})
      return null;
    }
  })(
    ${GLOBAL_EXECUTION_CONTEXT}.typeResolvers.${typeResolverName}(${joinOriginPaths(
    originPaths
  )},
    ${GLOBAL_CONTEXT_NAME},
    ${getExecutionInfo(
    context,
    parentType,
    type,
    type.name,
    fieldNodes,
    previousPath
  )}))`;
}
function compileListType(context, parentType, type, fieldNodes, originalObjectPaths, responsePath, errorDestination) {
  const name = originalObjectPaths.join(".");
  const listContext = createSubCompilationContext(context);
  const newDepth = ++listContext.depth;
  const fieldType = type.ofType;
  const dataBody = compileType(
    listContext,
    parentType,
    fieldType,
    fieldNodes,
    ["__currentItem"],
    [`${GLOBAL_PARENT_NAME}[idx${newDepth}]`],
    addPath(responsePath, "idx" + newDepth, "variable")
  );
  const errorMessage = `"Expected Iterable, but did not find one for field ${parentType.name}.${getFieldNodesName(fieldNodes)}."`;
  const errorCase = `(${errorDestination}.push(${createErrorObject(
    context,
    fieldNodes,
    responsePath,
    errorMessage
  )}), null)`;
  const executionError = createErrorObject(
    context,
    fieldNodes,
    addPath(responsePath, "idx" + newDepth, "variable"),
    "err.message != null ? err.message : err",
    "err"
  );
  const emptyError = createErrorObject(context, fieldNodes, responsePath, '""');
  const uniqueDeclarations = generateUniqueDeclarations(listContext);
  const deferredFields = compileDeferredFields(listContext);
  const itemHandler = getHoistedFunctionName(
    context,
    `${parentType.name}${originalObjectPaths.join("")}MapItemHandler`
  );
  const childIndexes = getParentArgIndexes(listContext);
  listContext.hoistedFunctions.push(`
  function ${itemHandler}(${GLOBAL_EXECUTION_CONTEXT}, ${GLOBAL_PARENT_NAME}, __currentItem, ${childIndexes}) {
    ${uniqueDeclarations}
    ${GLOBAL_PARENT_NAME}[idx${newDepth}] = ${dataBody};
    ${deferredFields}
  }
  `);
  const safeMapHandler = getHoistedFunctionName(
    context,
    `${parentType.name}${originalObjectPaths.join("")}MapHandler`
  );
  const parentIndexes = getParentArgIndexes(context);
  listContext.hoistedFunctions.push(`
  function ${safeMapHandler}(${GLOBAL_EXECUTION_CONTEXT}, __currentItem, idx${newDepth}, resultArray, ${parentIndexes}) {
    if (${isPromiseInliner("__currentItem")}) {
      ${promiseStarted()}
      __currentItem.then(result => {
        ${itemHandler}(${GLOBAL_EXECUTION_CONTEXT}, resultArray, result, ${childIndexes});
        ${promiseDone()}
      }, err => {
        resultArray.push(null);
        if (err) {
          ${getErrorDestination(fieldType)}.push(${executionError});
        } else {
          ${getErrorDestination(fieldType)}.push(${emptyError});
        }
        ${promiseDone()}
      });
    } else {
       ${itemHandler}(${GLOBAL_EXECUTION_CONTEXT}, resultArray, __currentItem, ${childIndexes});
    }
  }
  `);
  return `(typeof ${name} === "string" || typeof ${name}[Symbol.iterator] !== "function") ?  ${errorCase} :
  ${GLOBAL_SAFE_MAP_NAME}(${GLOBAL_EXECUTION_CONTEXT}, ${name}, ${safeMapHandler}, ${parentIndexes})`;
}
function safeMap(context, iterable, cb, ...idx) {
  let index = 0;
  const result = [];
  for (const a of iterable) {
    cb(context, a, index, result, ...idx);
    ++index;
  }
  return result;
}
const MAGIC_MINUS_INFINITY = "__MAGIC_MINUS_INFINITY__71d4310a_d4a3_4a05_b1fe_e60779d24998";
const MAGIC_PLUS_INFINITY = "__MAGIC_PLUS_INFINITY__bb201c39_3333_4695_b4ad_7f1722e7aa7a";
const MAGIC_NAN = "__MAGIC_NAN__57f286b9_4c20_487f_b409_79804ddcb4f8";
const MAGIC_DATE = "__MAGIC_DATE__33a9e76d_02e0_4128_8e92_3530ad3da74d";
function specialValueReplacer(key, value) {
  if (Number.isNaN(value)) {
    return MAGIC_NAN;
  }
  if (value === Infinity) {
    return MAGIC_PLUS_INFINITY;
  }
  if (value === -Infinity) {
    return MAGIC_MINUS_INFINITY;
  }
  if (this[key] instanceof Date) {
    return MAGIC_DATE + this[key].getTime();
  }
  return value;
}
function objectStringify(val) {
  return JSON.stringify(val, specialValueReplacer).replace(new RegExp(`"${MAGIC_NAN}"`, "g"), "NaN").replace(new RegExp(`"${MAGIC_PLUS_INFINITY}"`, "g"), "Infinity").replace(new RegExp(`"${MAGIC_MINUS_INFINITY}"`, "g"), "-Infinity").replace(new RegExp(`"${MAGIC_DATE}([^"]+)"`, "g"), "new Date($1)");
}
function getExecutionInfo(context, parentType, fieldType, fieldName, fieldNodes, responsePath) {
  const resolveInfoName = createResolveInfoName(responsePath);
  const { schema, fragments, operation } = context;
  context.resolveInfos[resolveInfoName] = createResolveInfoThunk(
    {
      schema,
      fragments,
      operation,
      parentType,
      fieldName,
      fieldType,
      fieldNodes
    },
    context.options.resolverInfoEnricher
  );
  return `${GLOBAL_EXECUTION_CONTEXT}.resolveInfos.${resolveInfoName}(${GLOBAL_ROOT_NAME}, ${GLOBAL_VARIABLES_NAME}, ${serializeResponsePath(
    responsePath
  )})`;
}
function getArgumentsName(prefixName) {
  return `${prefixName}Args`;
}
function getValidArgumentsVarName(prefixName) {
  return `${prefixName}ValidArgs`;
}
function objectPath(topLevel, path) {
  if (!path) {
    return topLevel;
  }
  let objectPath2 = topLevel;
  const flattened = flattenPath(path);
  for (const section of flattened) {
    if (section.type === "literal") {
      objectPath2 += `["${section.key}"]`;
    } else {
      throw new Error("should only have received literal paths");
    }
  }
  return objectPath2;
}
function compileArguments(context, args, topLevelArg, validArgs, returnType, path) {
  let body = `
  let ${validArgs} = true;
  const ${topLevelArg} = ${objectStringify(args.values)};
  `;
  const errorDestination = getErrorDestination(returnType);
  for (const variable of args.missing) {
    const varName = variable.valueNode.name.value;
    body += `if (Object.prototype.hasOwnProperty.call(${GLOBAL_VARIABLES_NAME}, "${varName}")) {`;
    if (variable.argument && isNonNullType(variable.argument.definition.type)) {
      const message = `'Argument "${variable.argument.definition.name}" of non-null type "${variable.argument.definition.type.toString()}" must not be null.'`;
      body += `if (${GLOBAL_VARIABLES_NAME}['${variable.valueNode.name.value}'] == null) {
      ${errorDestination}.push(${createErrorObject(
        context,
        [variable.argument.node.value],
        path,
        message
      )});
      ${validArgs} = false;
      }`;
    }
    body += `
    ${objectPath(topLevelArg, variable.path)} = ${GLOBAL_VARIABLES_NAME}['${variable.valueNode.name.value}'];
    }`;
    if (variable.argument && isNonNullType(variable.argument.definition.type) && variable.argument.definition.defaultValue === void 0) {
      const message = `'Argument "${variable.argument.definition.name}" of required type "${variable.argument.definition.type.toString()}" was provided the variable "$${varName}" which was not provided a runtime value.'`;
      body += ` else {
      ${errorDestination}.push(${createErrorObject(
        context,
        [variable.argument.node.value],
        path,
        message
      )});
      ${validArgs} = false;
        }`;
    }
  }
  return body;
}
function generateUniqueDeclarations(context, defaultValue = false) {
  return context.deferred.map(
    (_, idx) => `
        let ${SAFETY_CHECK_PREFIX}${idx} = ${defaultValue};
      `
  ).join("\n");
}
function createSubCompilationContext(context) {
  return { ...context, deferred: [] };
}
function isPromise(value) {
  return value != null && typeof value === "object" && typeof value.then === "function";
}
function isPromiseInliner(value) {
  return `${value} != null && typeof ${value} === "object" && typeof ${value}.then === "function"`;
}
function serializeResponsePathAsArray(path) {
  const flattened = flattenPath(path);
  let src = "[";
  for (let i = flattened.length - 1; i >= 0; i--) {
    if (flattened[i].type === "meta") {
      continue;
    }
    src += flattened[i].type === "literal" ? `"${flattened[i].key}",` : `${flattened[i].key},`;
  }
  return src + "]";
}
function getErrorDestination(type) {
  return isNonNullType(type) ? GLOBAL_NULL_ERRORS_NAME : GLOBAL_ERRORS_NAME;
}
function createResolveInfoName(path) {
  return flattenPath(path).map((p) => p.key).join("_") + "Info";
}
function serializeResponsePath(path) {
  if (!path) {
    return "undefined";
  }
  if (path.type === "meta") {
    return serializeResponsePath(path.prev);
  }
  const literalValue = `"${path.key}"`;
  return `{
    key:  ${path.type === "literal" ? literalValue : path.key},
    prev: ${serializeResponsePath(path.prev)}
  }`;
}
function getSerializer(scalar, customSerializer) {
  const { name } = scalar;
  const serialize = customSerializer || ((val) => scalar.serialize(val));
  return function leafSerializer(context, v, onError, ...idx) {
    try {
      const value = serialize(v);
      if (isInvalid(value)) {
        onError(
          context,
          `Expected a value of type "${name}" but received: ${v}`,
          ...idx
        );
        return null;
      }
      return value;
    } catch (e) {
      onError(
        context,
        e && e.message || `Expected a value of type "${name}" but received an Error`,
        ...idx
      );
      return null;
    }
  };
}
function defaultResolveTypeFn(value, contextValue, info, abstractType) {
  if (value != null && typeof value === "object" && typeof value.__typename === "string") {
    return value.__typename;
  }
  const possibleTypes = info.schema.getPossibleTypes(abstractType);
  for (const type of possibleTypes) {
    if (type.isTypeOf) {
      const isTypeOfResult = type.isTypeOf(value, contextValue, info);
      if (isPromise(isTypeOfResult)) {
        throw new Error(
          `Promises are not supported for resolving type of ${value}`
        );
      } else if (isTypeOfResult) {
        return type.name;
      }
    }
  }
  throw new Error(
    `Could not resolve the object type in possible types of ${abstractType.name} for the value: ` + inspect(value)
  );
}
function buildCompilationContext(schema, document, options, operationName) {
  const errors = [];
  let operation = void 0;
  let hasMultipleAssumedOperations = false;
  const fragments = /* @__PURE__ */ Object.create(null);
  for (const definition of document.definitions) {
    switch (definition.kind) {
      case Kind.OPERATION_DEFINITION:
        if (!operationName && operation) {
          hasMultipleAssumedOperations = true;
        } else if (!operationName || definition.name && definition.name.value === operationName) {
          operation = definition;
        }
        break;
      case Kind.FRAGMENT_DEFINITION:
        fragments[definition.name.value] = definition;
        break;
    }
  }
  if (!operation) {
    if (operationName) {
      throw new GraphQLError(`Unknown operation named "${operationName}".`);
    } else {
      throw new GraphQLError("Must provide an operation.");
    }
  } else if (hasMultipleAssumedOperations) {
    throw new GraphQLError(
      "Must provide operation name if query contains multiple operations."
    );
  }
  return {
    schema,
    fragments,
    rootValue: null,
    contextValue: null,
    operation,
    options,
    resolvers: {},
    serializers: {},
    typeResolvers: {},
    isTypeOfs: {},
    resolveInfos: {},
    hoistedFunctions: [],
    hoistedFunctionNames: /* @__PURE__ */ new Map(),
    deferred: [],
    depth: -1,
    variableValues: {},
    errors
  };
}
function getFieldNodesName(nodes) {
  return nodes.length > 1 ? "(" + nodes.map(({ name }) => name.value).join(",") + ")" : nodes[0].name.value;
}
function getHoistedFunctionName(context, name) {
  const count = context.hoistedFunctionNames.get(name);
  if (count === void 0) {
    context.hoistedFunctionNames.set(name, 0);
    return name;
  }
  context.hoistedFunctionNames.set(name, count + 1);
  return `${name}${count + 1}`;
}
function createErrorObject(context, nodes, path, message, originalError) {
  return `new ${GRAPHQL_ERROR}(${message},
    ${JSON.stringify(computeLocations(nodes))},
      ${serializeResponsePathAsArray(path)},
      ${originalError || "undefined"},
      ${context.options.disablingCapturingStackErrors ? "true" : "false"})`;
}
function getResolverName(parentName, name) {
  return parentName + name + "Resolver";
}
function getTypeResolverName(name) {
  return name + "TypeResolver";
}
function getSerializerName(name) {
  return name + "Serializer";
}
function promiseStarted() {
  return `
     // increase the promise counter
     ++${GLOBAL_PROMISE_COUNTER};
  `;
}
function promiseDone() {
  return `
    --${GLOBAL_PROMISE_COUNTER};
    if (${GLOBAL_PROMISE_COUNTER} === 0) {
      ${GLOBAL_RESOLVE}(${GLOBAL_EXECUTION_CONTEXT});
    }
  `;
}
function normalizeErrors(err) {
  if (Array.isArray(err)) {
    return err.map((e) => normalizeError(e));
  }
  return [normalizeError(err)];
}
function normalizeError(err) {
  return err instanceof GraphQLError ? err : new GraphqlJitError(
    err.message,
    err.locations,
    err.path,
    err
  );
}
function isInvalid(value) {
  return value === void 0 || value !== value;
}
function getParentArgIndexes(context) {
  let args = "";
  for (let i = 0; i <= context.depth; ++i) {
    if (i > 0) {
      args += ", ";
    }
    args += `idx${i}`;
  }
  return args;
}
function getJsFieldName(fieldName) {
  return `${LOCAL_JS_FIELD_NAME_PREFIX}${fieldName}`;
}
function isAsyncIterable(val) {
  return typeof Object(val)[Symbol.asyncIterator] === "function";
}
function compileSubscriptionOperation(context, type, fieldMap, queryFn) {
  const fieldNodes = Object.values(fieldMap)[0];
  const fieldNode = fieldNodes[0];
  const fieldName = fieldNode.name.value;
  const field = resolveFieldDef(context, type, fieldNodes);
  if (!field) {
    throw new GraphQLError(
      `The subscription field "${fieldName}" is not defined.`,
      getGraphQLErrorOptions(fieldNodes)
    );
  }
  const responsePath = addPath(void 0, fieldName);
  const resolveInfoName = createResolveInfoName(responsePath);
  const subscriber = field.subscribe;
  async function executeSubscription(executionContext) {
    const resolveInfo = executionContext.resolveInfos[resolveInfoName](
      executionContext.rootValue,
      executionContext.variables,
      responsePath
    );
    try {
      const eventStream = await subscriber?.(
        executionContext.rootValue,
        executionContext.variables,
        executionContext.context,
        resolveInfo
      );
      if (eventStream instanceof Error) {
        throw eventStream;
      }
      return eventStream;
    } catch (error) {
      throw locatedError(
        error,
        resolveInfo.fieldNodes,
        pathToArray(resolveInfo.path)
      );
    }
  }
  async function createSourceEventStream(executionContext) {
    try {
      const eventStream = await executeSubscription(executionContext);
      if (!isAsyncIterable(eventStream)) {
        throw new Error(
          `Subscription field must return Async Iterable. Received: ${inspect(eventStream)}.`
        );
      }
      return eventStream;
    } catch (error) {
      if (error instanceof GraphQLError) {
        return { errors: [error] };
      }
      throw error;
    }
  }
  return async function subscribe(executionContext) {
    const resultOrStream = await createSourceEventStream(executionContext);
    if (!isAsyncIterable(resultOrStream)) {
      return resultOrStream;
    }
    const mapSourceToResponse = (payload) => queryFn(payload, executionContext.context, executionContext.variables);
    return mapAsyncIterator(resultOrStream, mapSourceToResponse);
  };
}
function createBoundSubscribe(compilationContext, document, func, getVariableValues, operationName) {
  const { resolvers, typeResolvers, isTypeOfs, serializers, resolveInfos } = compilationContext;
  const trimmer = createNullTrimmer(compilationContext);
  const fnName = operationName || "subscribe";
  const ret = {
    async [fnName](rootValue, context, variables) {
      const parsedVariables = getVariableValues(variables || {});
      if (failToParseVariables(parsedVariables)) {
        return { errors: parsedVariables.errors };
      }
      const executionContext = {
        rootValue,
        context,
        variables: parsedVariables.coerced,
        safeMap,
        inspect,
        GraphQLError: GraphqlJitError,
        resolvers,
        typeResolvers,
        isTypeOfs,
        serializers,
        resolveInfos,
        trimmer,
        promiseCounter: 0,
        nullErrors: [],
        errors: [],
        data: {}
      };
      return func.call(null, executionContext);
    }
  };
  return ret[fnName];
}
function mapAsyncIterator(iterable, callback) {
  const iterator = iterable[Symbol.asyncIterator]();
  async function mapResult(result) {
    if (result.done) {
      return result;
    }
    try {
      return { value: await callback(result.value), done: false };
    } catch (error) {
      if (typeof iterator.return === "function") {
        try {
          await iterator.return();
        } catch (e) {
        }
      }
      throw error;
    }
  }
  return {
    async next() {
      return mapResult(await iterator.next());
    },
    async return() {
      return typeof iterator.return === "function" ? mapResult(await iterator.return()) : { value: void 0, done: true };
    },
    async throw(error) {
      return typeof iterator.throw === "function" ? mapResult(await iterator.throw(error)) : Promise.reject(error);
    },
    [Symbol.asyncIterator]() {
      return this;
    }
  };
}
function joinOriginPathsImpl(originPaths) {
  return originPaths.join(".");
}
function isNotNull(it) {
  return it != null;
}
export {
  GLOBAL_VARIABLES_NAME,
  compileQuery,
  createBoundQuery,
  isAsyncIterable,
  isCompiledQuery,
  isPromise,
  isPromiseInliner
};
//# sourceMappingURL=execution.mjs.map