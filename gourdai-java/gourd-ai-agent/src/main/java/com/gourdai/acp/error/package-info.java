/*
 * Copyright 2025-2025 the original author or authors.
 */

/**
 * Exception types and error codes for the ACP SDK.
 *
 * <p>
 * This package provides a structured exception hierarchy for handling errors in ACP
 * communication:
 * </p>
 *
 * <ul>
 * <li>{@link com.gourdai.acp.error.AcpException} - Base class for all ACP
 * errors</li>
 * <li>{@link com.gourdai.acp.error.AcpProtocolException} - JSON-RPC protocol
 * errors</li>
 * <li>{@link com.gourdai.acp.error.AcpCapabilityException} - Capability
 * negotiation errors</li>
 * <li>{@link com.gourdai.acp.error.AcpConnectionException} - Transport/connection
 * errors</li>
 * </ul>
 *
 * <p>
 * Standard error codes are defined in {@link com.gourdai.acp.error.AcpErrorCodes}.
 * </p>
 *
 * @see com.gourdai.acp.error.AcpErrorCodes
 */
package com.gourdai.acp.error;
