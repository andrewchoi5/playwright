/**
 * Copyright 2017 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { assert } from '../helper';
import * as debug from 'debug';
import { EventEmitter } from 'events';
import { ConnectionTransport } from '../transport';
import { Protocol } from './protocol';

const debugProtocol = debug('playwright:protocol');
const debugWrappedMessage = require('debug')('wrapped');

export const WKConnectionEvents = {
  TargetCreated: Symbol('ConnectionEvents.TargetCreated'),
  TargetDestroyed: Symbol('Connection.TargetDestroyed'),
  DidCommitProvisionalTarget: Symbol('Connection.DidCommitProvisionalTarget')
};

export class WKConnection extends EventEmitter {
  _lastId = 0;
  private readonly _callbacks = new Map<number, {resolve:(o: any) => void, reject:  (e: Error) => void, error: Error, method: string}>();
  private readonly _transport: ConnectionTransport;
  private readonly _sessions = new Map<string, WKTargetSession>();

  _closed = false;

  constructor(transport: ConnectionTransport) {
    super();
    this._transport = transport;
    this._transport.onmessage = this._dispatchMessage.bind(this);
    this._transport.onclose = this._onClose.bind(this);
  }

  send<T extends keyof Protocol.CommandParameters>(
    method: T,
    params?: Protocol.CommandParameters[T]
  ): Promise<Protocol.CommandReturnValues[T]> {
    const id = this._rawSend({method, params});
    return new Promise((resolve, reject) => {
      this._callbacks.set(id, {resolve, reject, error: new Error(), method});
    });
  }

  _rawSend(message: any): number {
    const id = ++this._lastId;
    message = JSON.stringify(Object.assign({}, message, {id}));
    debugProtocol('SEND ► ' + message);
    this._transport.send(message);
    return id;
  }

  private _dispatchMessage(message: string) {
    debugProtocol('◀ RECV ' + message);
    const object = JSON.parse(message);
    this._dispatchTargetMessageToSession(object, message);
    if (object.id) {
      const callback = this._callbacks.get(object.id);
      // Callbacks could be all rejected if someone has called `.dispose()`.
      if (callback) {
        this._callbacks.delete(object.id);
        if (object.error)
          callback.reject(createProtocolError(callback.error, callback.method, object));
        else
          callback.resolve(object.result);
      } else {
        assert(this._closed, 'Received response for unknown callback: ' + object.id);
      }
    } else {
      Promise.resolve().then(() => this.emit(object.method, object.params));
    }
  }

  _dispatchTargetMessageToSession(object: {method: string, params: any}, wrappedMessage: string) {
    if (object.method === 'Target.targetCreated') {
      const targetInfo = object.params.targetInfo as Protocol.Target.TargetInfo;
      const session = new WKTargetSession(this, targetInfo);
      this._sessions.set(session._sessionId, session);
      Promise.resolve().then(() => this.emit(WKConnectionEvents.TargetCreated, session, object.params.targetInfo));
    } else if (object.method === 'Target.targetDestroyed') {
      const session = this._sessions.get(object.params.targetId);
      if (session) {
        session._onClosed();
        this._sessions.delete(object.params.targetId);
      }
      Promise.resolve().then(() => this.emit(WKConnectionEvents.TargetDestroyed, { targetId: object.params.targetId, crashed: object.params.crashed }));
    } else if (object.method === 'Target.dispatchMessageFromTarget') {
      const {targetId, message} = object.params as Protocol.Target.dispatchMessageFromTargetPayload;
      const session = this._sessions.get(targetId);
      if (!session)
        throw new Error('Unknown target: ' + targetId);
      if (session.isProvisional())
        session._addProvisionalMessage(message);
      else
        session._dispatchMessageFromTarget(message);
    } else if (object.method === 'Target.didCommitProvisionalTarget') {
      const {oldTargetId, newTargetId} = object.params as Protocol.Target.didCommitProvisionalTargetPayload;
      Promise.resolve().then(() => this.emit(WKConnectionEvents.DidCommitProvisionalTarget, { oldTargetId, newTargetId }));
      const newSession = this._sessions.get(newTargetId);
      if (!newSession)
        throw new Error('Unknown new target: ' + newTargetId);
      const oldSession = this._sessions.get(oldTargetId);
      if (!oldSession)
        throw new Error('Unknown old target: ' + oldTargetId);
      oldSession._swappedOut = true;
      for (const message of newSession._takeProvisionalMessagesAndCommit())
        newSession._dispatchMessageFromTarget(message);
    }
  }

  _onClose() {
    if (this._closed)
      return;
    this._closed = true;
    this._transport.onmessage = null;
    this._transport.onclose = null;
    for (const callback of this._callbacks.values())
      callback.reject(rewriteError(callback.error, `Protocol error (${callback.method}): Target closed.`));
    this._callbacks.clear();
    for (const session of this._sessions.values())
      session._onClosed();
    this._sessions.clear();
  }

  dispose() {
    this._onClose();
    this._transport.close();
  }
}

export const WKTargetSessionEvents = {
  Disconnected: Symbol('TargetSessionEvents.Disconnected')
};

export class WKTargetSession extends EventEmitter {
  private _connection: WKConnection;
  private _callbacks = new Map<number, {resolve:(o: any) => void, reject: (e: Error) => void, error: Error, method: string}>();
  private _targetType: string;
  _sessionId: string;
  _swappedOut = false;
  private _provisionalMessages?: string[];
  on: <T extends keyof Protocol.Events | symbol>(event: T, listener: (payload: T extends symbol ? any : Protocol.Events[T extends keyof Protocol.Events ? T : never]) => void) => this;
  addListener: <T extends keyof Protocol.Events | symbol>(event: T, listener: (payload: T extends symbol ? any : Protocol.Events[T extends keyof Protocol.Events ? T : never]) => void) => this;
  off: <T extends keyof Protocol.Events | symbol>(event: T, listener: (payload: T extends symbol ? any : Protocol.Events[T extends keyof Protocol.Events ? T : never]) => void) => this;
  removeListener: <T extends keyof Protocol.Events | symbol>(event: T, listener: (payload: T extends symbol ? any : Protocol.Events[T extends keyof Protocol.Events ? T : never]) => void) => this;
  once: <T extends keyof Protocol.Events | symbol>(event: T, listener: (payload: T extends symbol ? any : Protocol.Events[T extends keyof Protocol.Events ? T : never]) => void) => this;

  constructor(connection: WKConnection, targetInfo: Protocol.Target.TargetInfo) {
    super();
    const {targetId, type, isProvisional} = targetInfo;
    this._connection = connection;
    this._targetType = type;
    this._sessionId = targetId;
    if (isProvisional)
      this._provisionalMessages = [];
  }

  isProvisional() : boolean {
    return !!this._provisionalMessages;
  }

  send<T extends keyof Protocol.CommandParameters>(
    method: T,
    params?: Protocol.CommandParameters[T]
  ): Promise<Protocol.CommandReturnValues[T]> {
    if (!this._connection)
      return Promise.reject(new Error(`Protocol error (${method}): Session closed. Most likely the ${this._targetType} has been closed.`));
    const innerId = ++this._connection._lastId;
    const messageObj = {
      id: innerId,
      method,
      params
    };
    debugWrappedMessage('SEND ► ' + JSON.stringify(messageObj, null, 2));
    // Serialize message before adding callback in case JSON throws.
    const message = JSON.stringify(messageObj);
    const result = new Promise<Protocol.CommandReturnValues[T]>((resolve, reject) => {
      this._callbacks.set(innerId, {resolve, reject, error: new Error(), method});
    });
    this._connection.send('Target.sendMessageToTarget', {
      message: message, targetId: this._sessionId
    }).catch(e => {
      // There is a possible race of the connection closure. We may have received
      // targetDestroyed notification before response for the command, in that
      // case it's safe to swallow the exception.
      const callback = this._callbacks.get(innerId);
      assert(!callback, 'Callback was not rejected when target was destroyed.');
    });
    return result;
  }

  _addProvisionalMessage(message: string) {
    this._provisionalMessages.push(message);
  }

  _takeProvisionalMessagesAndCommit() : string[] {
    const messages = this._provisionalMessages;
    this._provisionalMessages = undefined;
    return messages;
  }

  _dispatchMessageFromTarget(message: string) {
    console.assert(!this.isProvisional());
    const object = JSON.parse(message);
    debugWrappedMessage('◀ RECV ' + JSON.stringify(object, null, 2));
    if (object.id && this._callbacks.has(object.id)) {
      const callback = this._callbacks.get(object.id);
      this._callbacks.delete(object.id);
      if (object.error)
        callback.reject(createProtocolError(callback.error, callback.method, object));
      else
        callback.resolve(object.result);
    } else {
      assert(!object.id);
      Promise.resolve().then(() => this.emit(object.method, object.params));
    }
  }

  _onClosed() {
    for (const callback of this._callbacks.values()) {
      // TODO: make some calls like screenshot catch swapped out error and retry.
      if (this._swappedOut)
        callback.reject(rewriteError(callback.error, `Protocol error (${callback.method}): Target was swapped out.`));
      else
        callback.reject(rewriteError(callback.error, `Protocol error (${callback.method}): Target closed.`));
    }
    this._callbacks.clear();
    this._connection = null;
    Promise.resolve().then(() => this.emit(WKTargetSessionEvents.Disconnected));
  }
}

function createProtocolError(error: Error, method: string, object: { error: { message: string; data: any; }; }): Error {
  let message = `Protocol error (${method}): ${object.error.message}`;
  if ('data' in object.error)
    message += ` ${object.error.data}`;
  return rewriteError(error, message);
}

function rewriteError(error: Error, message: string): Error {
  error.message = message;
  return error;
}

export function isSwappedOutError(e: Error) {
  return e.message.includes('Target was swapped out.');
}