package com.ruoyi.iterminal.api;

/**
 * 客户端接口（/api/v1/**）的统一响应：{code, message, data}，成功时 code = 0。
 * 和管理后台的 AjaxResult 不同：客户端按 HTTP 状态码判断成败，失败时状态码是 4xx / 5xx。
 */
public class ApiResult<T>
{
    private int code;

    private String message;

    private T data;

    public static <T> ApiResult<T> ok(T data)
    {
        ApiResult<T> r = new ApiResult<>();
        r.code = 0;
        r.message = "ok";
        r.data = data;
        return r;
    }

    public static <T> ApiResult<T> error(int code, String message)
    {
        ApiResult<T> r = new ApiResult<>();
        r.code = code;
        r.message = message;
        return r;
    }

    public int getCode()
    {
        return code;
    }

    public String getMessage()
    {
        return message;
    }

    public T getData()
    {
        return data;
    }
}
