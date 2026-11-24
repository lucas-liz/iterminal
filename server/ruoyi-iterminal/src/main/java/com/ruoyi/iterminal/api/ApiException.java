package com.ruoyi.iterminal.api;

import org.springframework.http.HttpStatus;

/**
 * 客户端接口的业务异常：带 HTTP 状态码，message 直接展示给用户（中文）。
 */
public class ApiException extends RuntimeException
{
    private static final long serialVersionUID = 1L;

    private final HttpStatus status;

    public ApiException(HttpStatus status, String message)
    {
        super(message);
        this.status = status;
    }

    public HttpStatus getStatus()
    {
        return status;
    }

    public static ApiException badRequest(String message)
    {
        return new ApiException(HttpStatus.BAD_REQUEST, message);
    }

    public static ApiException unauthorized(String message)
    {
        return new ApiException(HttpStatus.UNAUTHORIZED, message);
    }

    public static ApiException forbidden(String message)
    {
        return new ApiException(HttpStatus.FORBIDDEN, message);
    }

    public static ApiException notFound(String message)
    {
        return new ApiException(HttpStatus.NOT_FOUND, message);
    }

    public static ApiException conflict(String message)
    {
        return new ApiException(HttpStatus.CONFLICT, message);
    }
}
